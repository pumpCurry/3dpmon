/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 データモデルモジュール
 * @file dashboard_data.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_data
 *
 * 【機能内容サマリ】
 * - monitorData を中心としたアプリケーション状態管理
 * - currentHostname の保持
 * - storedData/runtimeData への読み書きユーティリティ
 *
 * 【公開関数一覧】
 * - {@link createEmptyMachineData}：空データ生成
 * - {@link ensureMachineData}：ホスト別データ初期化
 * - {@link setCurrentHostname}：現在ホスト設定
 * - {@link getCurrentMachine}：現在ホストのデータ取得
 * - {@link setStoredData}：storedData に値格納
 * - {@link getDisplayValue}：表示用値取得
 * - {@link consumeDirtyKeys}：変更キュー消費
 * - {@link markAllKeysDirty}：全キーを変更済みにマーク
 *
* @version 1.390.783 (PR #366)
* @since   1.390.193 (PR #86)
* @lastModified 2026-03-10 23:00:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

// プリセットフィラメント情報を取り込む
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { pushLog } from "./dashboard_log_util.js";

/**
 * @typedef {Object} StoredDatum
 * @property {*}     rawValue        元の生データ
 * @property {*}     computedValue   UI 用に変換されたデータ
 * @property {boolean} isNew          DOM 反映対象フラグ
 * @property {boolean} isFromEquipVal 設備値に由来するフラグ
 */

/**
 * @typedef {Object} MachineData
 * @property {Object.<string,StoredDatum>} storedData  表示・UI 用データ
 * @property {Object}                runtimeData  揮発性データ（heartbeat など）
 * @property {Array<Object>}         historyData  印刷履歴
 * @property {{current:Object|null, history:Array<Object>, videos:Object}} printStore
 *   履歴や動画を保持するストア
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
 * 最初に接続したホスト名（デフォルトパラメータの初期値として使用）。
 * マルチプリンタ環境では全ホストが並行動作するため、
 * 「アクティブホスト」や「表示中ホスト」の概念はない。
 * パネルは各ホストに紐付いており、表示切替は存在しない。
 * この変数は後方互換のために残しているが、新規コードでは
 * 必ず hostname 引数を明示的に渡すこと。
 * - null の場合: 未設定または初期化前
 * - PLACEHOLDER_HOSTNAME の場合: 強制的な「未選択」状態
 * - 通常は最初に接続された実際のホスト名文字列を保持する
 * @type {string|null}
 * @deprecated 新規コードでは hostname パラメータを明示的に使用すること
 */
export let currentHostname = null;

/**
 * 通知抑制状態フラグ
 *
 * true の間は NotificationManager.notify() による通知を抑制します。
 * 接続処理中や機器未選択時に誤通知が発生するのを防止する目的で使用します。
 * @type {boolean}
 */
export let notificationSuppressed = true;

/**
 * setNotificationSuppressed:
 * 通知抑制状態を更新します。
 *
 * @param {boolean} flag - true で通知抑制、false で通知許可
 * @returns {void}
 */
export function setNotificationSuppressed(flag) {
  notificationSuppressed = flag;
}

/**
 * createEmptyMachineData:
 * 新規の MachineData オブジェクトを生成して返します。
 *
 * @returns {MachineData} 初期化済みのオブジェクト
 */
export function createEmptyMachineData() {
  return {
    storedData: {},
    runtimeData: { lastError: null },
    historyData: [],
    printStore: { current: null, history: [], videos: {} }
  };
}

/**
 * ensureMachineData:
 * 既存 MachineData の欠落フィールドを補完します。
 *
 * @param {string} host - ホスト名
 * @returns {void}
 */
export function ensureMachineData(host) {
  const machine = monitorData.machines[host];
  if (!machine) {
    monitorData.machines[host] = createEmptyMachineData();
    return;
  }
  machine.storedData  ??= {};
  machine.runtimeData ??= { lastError: null };
  if (!('lastError' in machine.runtimeData)) {
    machine.runtimeData.lastError = null;
  }
  machine.historyData ??= [];
  if (!machine.printStore) {
    machine.printStore = { current: null, history: [], videos: {} };
  } else {
    machine.printStore.current  ??= null;
    machine.printStore.history ??= [];
    machine.printStore.videos  ??= {};
  }
}

/**
 * setCurrentHostname:
 * 指定されたホスト名を現在の監視対象として設定し、
 * monitorData.machines に当該ホスト用のデータ構造がなければ初期化します。
 *
 * @param {string} host - 設定する機器ホスト名（nullやPLACEHOLDER_HOSTNAME以外）
 */
export function setCurrentHostname(host) {
  currentHostname = host;
  ensureMachineData(host);

  // 旧バージョンの printManager データを新ストアへ移行する
  // プレースホルダ状態のまま移行するとコンタミネーションを招くため
  // 実際のホストが設定されたときだけ処理を行う
  if (host !== PLACEHOLDER_HOSTNAME) {
    const pm = monitorData.appSettings.printManager;
    if (pm && monitorData.machines[host]) {
      const store = monitorData.machines[host].printStore;
      if (pm.current != null && store.current == null) {
        store.current = pm.current;
      }
      if (Array.isArray(pm.history) && store.history.length === 0) {
        store.history = pm.history;
      }
      if (pm.videos && Object.keys(store.videos).length === 0) {
        store.videos = pm.videos;
      }
      delete monitorData.appSettings.printManager;
    }
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
 *   filamentPresets: Array<Object>,
 *   usageHistory: Array<Object>,
 *   filamentInventory: Array<Object>,
 *   currentSpoolId: string|null,
 *   hostSpoolMap: Object.<string, string|null>,
 *   spoolSerialCounter: number
 * }}
 */
export const monitorData = {
  appSettings: {
    updateInterval: 500,
    logMaxLines: 1000,
    logLevel: "info",
    autoConnect: true,
    wsDest: "",          // 接続先 IP:PORT（メイン、後方互換）
    connectionTargets: [],  // 複数接続先リスト [{dest, color?, label?}]
    showHostTag: true,      // パネルヘッダーにホスト名を表示する
    cameraToggle: false,  // カメラ ON/OFF
    cameraPort: 8080,     // カメラストリームポート（デフォルト。per-host は connectionTargets.cameraPort）
    httpPort: 80,         // HTTP ポート（デフォルト。印刷履歴・ファイル取得用）
    notificationSettings: {}
  },
  machines: {
    [PLACEHOLDER_HOSTNAME]: {
      storedData: {},
      runtimeData: {},
      historyData: [],
      printStore: {
        current: null,
        history: [],
        videos: {}
      }
    }
  },
  filamentSpools: [],
  filamentPresets: FILAMENT_PRESETS,
  usageHistory: [],
  filamentInventory: [],
  currentSpoolId: null,
  /**
   * ホストごとの装着スプールIDマップ。
   * キーはホスト名、値はスプールID。
   * per-host で異なるスプールを装着できるようにする。
   * @type {Object.<string, string|null>}
   */
  hostSpoolMap: {},
  /**
   * スプール通し番号の採番用カウンタ
   * @type {number}
   */
  spoolSerialCounter: 0,
  temporaryBuffer: []
};


/**
 * getCurrentMachine:
 *  - currentHostname に対応する MachineData を返す
 * @deprecated setStoredDataForHost / getMachineByHost を使用すること
 * @returns {MachineData|null}
 */
export function getCurrentMachine() {
  return currentHostname ? monitorData.machines[currentHostname] : null;
}

/**
 * setStoredDataForHost:
 *  - 指定ホストの storedData[key] に rawValue を直接設定する。
 *  - currentHostname 以外のホストのデータを蓄積する目的で使用する。
 *  - タイマーやUIは更新せず、データのみ保存する。
 *
 * @param {string} host  - 対象ホスト名
 * @param {string} key   - フィールド名
 * @param {*}      value - 設定する値
 * @returns {void}
 */
export function setStoredDataForHost(host, key, value, isRaw = true, isFromEquipVal) {
  ensureMachineData(host);
  const machine = monitorData.machines[host];
  if (!machine) return;
  let d = machine.storedData[key];
  if (!d) {
    d = { rawValue: null, computedValue: null, isNew: true, isFromEquipVal: false };
    machine.storedData[key] = d;
  }
  if (isRaw) {
    const newFlag = (isFromEquipVal !== undefined ? isFromEquipVal : false);
    // 値と isFromEquipVal が同一なら dirty マークをスキップ（不要な再描画を抑制）
    if (d.rawValue === value && d.isFromEquipVal === newFlag && !d.isNew) return;
    d.rawValue = value;
    d.isFromEquipVal = newFlag;
  } else {
    // computedValue が同一なら dirty マークをスキップ
    const newFlag = isFromEquipVal !== undefined ? isFromEquipVal : d.isFromEquipVal;
    if (d.computedValue === value && d.isFromEquipVal === newFlag && !d.isNew) return;
    d.computedValue = value;
    if (isFromEquipVal !== undefined) d.isFromEquipVal = isFromEquipVal;
  }
  d.isNew = true;
  _getDirtySet(host).add(key);
}

/**
 * setStoredData:
 *  - currentHostname の storedData[key] に raw/computed を設定し、isNew フラグを立てる
 *
 * @deprecated setStoredDataForHost(host, key, value) を使用すること
 * @param {string}  key                - フィールド名
 * @param {*}       value              - 設定する値
 * @param {boolean} [isRaw=false]      - true のとき rawValue、false のとき computedValue として扱う
 * @param {boolean} [isFromEquipVal]
 *   - isRaw=true の場合は指定値を保存し、未指定時は false。isRaw=false の場合は未指定なら保持、指定時は書き換え
 *   - isFromEquipValは、指定を禁止する(undefinedになるようにする)。
 *     - 利用可能な条件は、起動時のリストアと、handleMessage内 2.7.3 のみ。
*/
export function setStoredData(key, value, isRaw = false, isFromEquipVal) {
  console.warn("[setStoredData] deprecated: use setStoredDataForHost(host, key, value) instead");
  const machine = getCurrentMachine();
  if (!machine) return;
  let d = machine.storedData[key];
  if (!d) {
    // 新しくキーが作成された場合は isFromEquipVal を明示的に設定する
    d = { rawValue: null, computedValue: null, isNew: true, isFromEquipVal: false };
    machine.storedData[key] = d;
  }
  if (isRaw) {
    // 生値更新時は常にフラグを上書きする
    const prevRaw  = d.rawValue;
    const prevFlag = d.isFromEquipVal;
    const newFlag  = (isFromEquipVal !== undefined ? isFromEquipVal : false);
    // 値と isFromEquipVal が同一なら dirty マークをスキップ（不要な再描画を抑制）
    if (prevRaw === value && prevFlag === newFlag && !d.isNew) return;
    d.rawValue = value;
    d.isFromEquipVal = newFlag;
    // isFromEquipVal が true から false に変わり、値も変化した場合はログ出力
    if (
      prevFlag === true &&
      newFlag === false &&
      prevRaw !== value
    ) {
      const msg = `[setStoredData] isFromEquipVal changed to false for key: ${key}`;
      console.error(msg);
      pushLog(msg, "error", false, host);
    }
  } else {
    // computedValue 更新時は指定があればフラグ更新、無ければ保持
    const newFlag = isFromEquipVal !== undefined ? isFromEquipVal : d.isFromEquipVal;
    if (d.computedValue === value && d.isFromEquipVal === newFlag && !d.isNew) return;
    d.computedValue = value;
    if (isFromEquipVal !== undefined) {
      d.isFromEquipVal = isFromEquipVal;
    } else if (d.isFromEquipVal === undefined) {
      d.isFromEquipVal = false;
    }
  }
  d.isNew = true;
  if (currentHostname) _getDirtySet(currentHostname).add(key);
}

/**
 * getDisplayValue:
 *  - storedData[fieldName] から {value,unit} 形式の表示用オブジェクトを生成
 *
 * @param {string} fieldName
 * @param {string} [hostname] - 対象ホスト名
 * @returns {{value:string,unit:string}|null}
 */
export function getDisplayValue(fieldName, hostname) {
  const machine = hostname
    ? monitorData.machines[hostname]
    : getCurrentMachine();
  if (!machine) return null;
  const d = machine.storedData[fieldName];
  if (!d) return null;
  if (d.computedValue && typeof d.computedValue === "object" && "value" in d.computedValue) {
    return { value: String(d.computedValue.value), unit: d.computedValue.unit || "" };
  }
  return { value: String(d.rawValue ?? ""), unit: "" };
}

/**
 * パネルシステムでスコープ付きIDの要素を検索する。
 * パネル内の要素IDは `{hostname}__originalId` 形式にプレフィックス変換されるため、
 * まずスコープ付きIDで検索し、見つからなければ元のIDにフォールバックする。
 *
 * @param {string} id - 元の要素ID
 * @param {string} hostname - ホスト名
 * @returns {HTMLElement|null}
 */
export function scopedById(id, hostname) {
  const host = hostname;
  if (host) {
    const prefix = host.replace(/[^a-zA-Z0-9_-]/g, "_");
    const el = document.getElementById(`${prefix}__${id}`);
    if (el) return el;
  }
  return document.getElementById(id);
}

/* 非モジュールスクリプト（dashboard_stage_preview.js 等）からも使えるようグローバルに公開 */
window.scopedById = scopedById;

/* ─── 変更キュー（A: Dirty Key Queue — per-host） ─── */

/**
 * ホストごとに変更されたキーを蓄積する Map。
 * setStoredData / setStoredDataForHost で変更が入ったキーを
 * ホスト別に記録し、updateStoredDataToDOM で各ホストの
 * パネルだけを正確に更新する。
 *
 * @type {Map<string, Set<string>>}
 * @private
 */
const _dirtyKeysMap = new Map();

/**
 * _getDirtySet:
 * 指定ホスト用の dirty Set を返す（無ければ作成）。
 *
 * @private
 * @param {string} host - ホスト名
 * @returns {Set<string>}
 */
function _getDirtySet(host) {
  if (!_dirtyKeysMap.has(host)) _dirtyKeysMap.set(host, new Set());
  return _dirtyKeysMap.get(host);
}

/**
 * consumeDirtyKeysForHost:
 * 指定ホストの変更キーを配列として返し、そのホストのセットをクリアする。
 *
 * @param {string} host - 対象ホスト名
 * @returns {string[]} 変更があったキーの配列
 */
export function consumeDirtyKeysForHost(host) {
  const set = _dirtyKeysMap.get(host);
  if (!set || set.size === 0) return [];
  const keys = [...set];
  set.clear();
  return keys;
}

/**
 * getHostsWithDirtyKeys:
 * dirty key を持つ全ホスト名を返す。
 * updateStoredDataToDOM で全ホストを巡回する際に使用する。
 *
 * @returns {string[]} dirty key を持つホスト名の配列
 */
export function getHostsWithDirtyKeys() {
  const hosts = [];
  for (const [host, set] of _dirtyKeysMap) {
    if (set.size > 0) hosts.push(host);
  }
  return hosts;
}

/**
 * consumeDirtyKeys:
 * 後方互換用。currentHostname の変更キーを消費する。
 * @deprecated consumeDirtyKeysForHost を使用すること
 * @returns {string[]}
 */
export function consumeDirtyKeys() {
  if (!currentHostname) return [];
  return consumeDirtyKeysForHost(currentHostname);
}

/**
 * markAllKeysDirty:
 * 指定ホストの storedData 全キーを
 * そのホストの変更キューに追加する。パネル生成後やデータ再読み込み時に
 * 全フィールドの DOM 再描画をトリガーするために使用する。
 *
 * @param {string} hostname - 対象ホスト名
 * @returns {void}
 */
export function markAllKeysDirty(hostname) {
  const host = hostname;
  if (!host) return;
  const machine = monitorData.machines[host];
  if (!machine) return;
  const dirtySet = _getDirtySet(host);
  for (const key in machine.storedData) {
    machine.storedData[key].isNew = true;
    dirtySet.add(key);
  }
}



