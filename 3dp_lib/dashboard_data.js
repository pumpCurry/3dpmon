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
 * - currentHostname の保持（後方互換用、@deprecated）
 * - storedData/runtimeData への読み書きユーティリティ
 *
 * 【公開関数一覧】
 * - {@link createEmptyMachineData}：空データ生成
 * - {@link ensureMachineData}：ホスト別データ初期化
 * - {@link setCurrentHostname}：現在ホスト設定
 * - {@link getDisplayValue}：表示用値取得
 * - {@link markAllKeysDirty}：全キーを変更済みにマーク
 *
* @version 1.390.787 (PR #367)
* @since   1.390.193 (PR #86)
* @lastModified 2026-03-12
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

// プリセットフィラメント情報を取り込む
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";


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

// ★ currentHostname は v2.2.0 で完全削除済み。
// マルチホスト環境ではグローバルな「現在のホスト」は存在しない。

/**
 * 通知抑制状態フラグ
 *
 * true の間は NotificationManager.notify() による通知を抑制します。
 * 接続処理中や機器未選択時に誤通知が発生するのを防止する目的で使用します。
 * ★ per-host Map に変更: 各ホスト独立に抑制/許可を管理する。
 *   host2 の切断が host1 の通知を抑制しないようにする。
 * @type {Map<string, boolean>}
 */
const _notificationSuppressedMap = new Map();

/**
 * 指定ホストの通知が抑制されているかを返す。
 * ホスト未登録の場合はグローバル起動中抑制として true を返す。
 *
 * @param {string} [hostname] - ホスト名（省略時は全ホスト対象でいずれかが非抑制なら false）
 * @returns {boolean}
 */
export function isNotificationSuppressed(hostname) {
  if (hostname) return _notificationSuppressedMap.get(hostname) ?? true;
  // hostname 省略時: 全ホストが抑制されているかチェック
  if (_notificationSuppressedMap.size === 0) return true;
  for (const v of _notificationSuppressedMap.values()) {
    if (!v) return false;
  }
  return true;
}

// ★ notificationSuppressed は v2.2.0 で完全削除済み。
// isNotificationSuppressed(hostname) を使用すること。

/**
 * setNotificationSuppressed:
 * 通知抑制状態を更新します。
 *
 * @param {boolean} flag - true で通知抑制、false で通知許可
 * @param {string} [hostname] - ホスト名（省略時は全ホスト一括設定）
 * @returns {void}
 */
export function setNotificationSuppressed(flag, hostname) {
  if (hostname) {
    _notificationSuppressedMap.set(hostname, flag);
  } else {
    // hostname 省略: 全ホスト一括（起動時の初期抑制用）
    for (const h of Object.keys(monitorData.machines)) {
      if (h !== PLACEHOLDER_HOSTNAME) _notificationSuppressedMap.set(h, flag);
    }
  }
  // (v2.2.0: notificationSuppressed グローバルは削除済み)
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
    /** @deprecated printStore.history が権威。historyData は中間バッファとしてのみ使用。
     *  将来的に printStore.history に完全統合し、historyData は廃止予定。 */
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
  if (!machine.printStore || typeof machine.printStore !== "object") {
    // ★ printStore が null/undefined/非オブジェクトの場合のみ初期化
    // （削除ロジックで null にされた場合はここで復元）
    machine.printStore = { current: null, history: [], videos: {} };
    console.debug(`[ensureMachineData] ${host}: printStore を初期化`);
  } else {
    machine.printStore.current  ??= null;
    machine.printStore.history ??= [];
    machine.printStore.videos  ??= {};
  }
}

// ★ setCurrentHostname は v2.2.0 で完全削除済み。
// ensureMachineData(host) を直接使用すること。

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
 *   userPresets: Array<Object>,
 *   hiddenPresets: Array<string>,
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
    // ★ wsDest は v2.2.0 で完全削除済み。connectionTargets が唯一の接続先リスト。
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
  /** ユーザー定義プリセット（カスタムフィラメント銘柄） @type {Array<Object>} */
  userPresets: [],
  /** 非表示プリセットID一覧 @type {Array<string>} */
  hiddenPresets: [],
  /** お気に入りプリセットID一覧 @type {Array<string>} */
  favoritePresets: [],
  usageHistory: [],
  filamentInventory: [],
  // ★ currentSpoolId は廃止。hostSpoolMap が唯一の権威。
  /**
   * ホストごとの装着スプールIDマップ。
   * キーはホスト名、値はスプールID。
   * per-host で異なるスプールを装着できるようにする。
   * @type {Object.<string, string|null>}
   */
  hostSpoolMap: {},
  /**
   * ホストごとのカメラON/OFF状態
   * @type {Object.<string, boolean>}
   */
  hostCameraToggle: {},
  /**
   * スプール通し番号の採番用カウンタ
   * @type {number}
   */
  spoolSerialCounter: 0,
  // ★ temporaryBuffer は廃止済み（単一ホスト時代の遺物）。
};



/**
 * setStoredDataForHost:
 *  - 指定ホストの storedData[key] に rawValue を直接設定する。
 *  - 全ホストのデータ蓄積に使用する（per-host 対応済みの標準API）。
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
 * getDisplayValue:
 *  - storedData[fieldName] から {value,unit} 形式の表示用オブジェクトを生成
 *
 * @param {string} fieldName
 * @param {string} hostname - 対象ホスト名
 * @returns {{value:string,unit:string}|null}
 */
export function getDisplayValue(fieldName, hostname) {
  if (!hostname) return null;
  const machine = monitorData.machines[hostname];
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
 * setStoredDataForHost で変更が入ったキーを
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



