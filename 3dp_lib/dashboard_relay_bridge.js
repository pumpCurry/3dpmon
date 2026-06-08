/**
 * @fileoverview
 * @description 3dpmon 親側リレーブリッジ — aggregator → 子クライアントへのデータ配信
 * @file dashboard_relay_bridge.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_relay_bridge
 *
 * 【機能内容サマリ】
 * - aggregator 更新後に dirty keys を収集し、リレーサーバにブロードキャスト
 * - 子（satellite）からのコマンド/フィラメント操作を受信し実行
 * - 新規子クライアント接続時にフルスナップショットを送信
 *
 * 【公開関数一覧】
 * - {@link initRelayBridge}：ブリッジを初期化する
 *
 * @version 1.390.820 (PR #367)
 * @since   1.390.820 (PR #367)
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData, PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { sendCommand, getHttpPort } from "./dashboard_connection.js";

/** ブリッジ初期化済みフラグ */
let _initialized = false;

/** 前回ブロードキャスト時の各ホスト・各キーの rawValue スナップショット */
const _prevSnapshot = new Map();

/** 前回ブロードキャストした共有データのハッシュ（簡易変更検出） */
let _prevSharedHash = "";

/** 前回ブロードキャスト時の各ホストの印刷履歴(printStore)ハッシュ */
const _prevPrintHash = new Map();

/** 前回ブロードキャスト時の各ホストのファイル一覧(_cachedFileInfo)ハッシュ */
const _prevFileHash = new Map();

/** ブロードキャスト間隔 (ms) — aggregator と同じ 500ms（子を 2回/秒で更新）。
 *  差分は変化キーのみなので 1000ms→500ms でも転送量増は軽微。 */
const BROADCAST_INTERVAL_MS = 500;

/** 最終ブロードキャスト時刻 */
let _lastBroadcastMs = 0;

/** 前回送信したカメラエンドポイントマップのハッシュ（変更検出） */
let _prevCameraEpHash = "";

/**
 * 親側リレーブリッジを初期化する。
 * Electron 環境でのみ動作し、aggregator の post-update コールバックとして登録される。
 *
 * ★ この関数は aggregatorUpdate() の末尾から呼ばれることを想定。
 *    500ms ごとに呼ばれるが、実際のブロードキャストは BROADCAST_INTERVAL_MS ごとに行う。
 *
 * @returns {boolean} 初期化成功なら true
 */
export function initRelayBridge() {
  if (_initialized) return true;
  if (!window.electronAPI?.relayBroadcast) {
    // Electron 環境でないか、preload に relayBroadcast がない
    return false;
  }

  // 子クライアントからのコマンド受信
  window.electronAPI.onRelayCommand?.((data) => {
    const { target, method, params } = data;
    if (target && method) {
      console.debug(`[relay-bridge] 子からコマンド受信: ${method} → ${target}`);
      sendCommand(method, params || {}, target);
    }
  });

  // 子クライアントからのフィラメント操作受信
  window.electronAPI.onRelayFilament?.(async (data) => {
    console.debug(`[relay-bridge] 子からフィラメント操作受信:`, data.action);
    // フィラメント操作は動的インポートで循環参照回避
    try {
      const { setCurrentSpoolId } = await import("./dashboard_spool.js");
      const { saveUnifiedStorage } = await import("./dashboard_storage.js");
      switch (data.action) {
        case "mount":
          if (data.data.spoolId && data.data.hostname) {
            setCurrentSpoolId(data.data.spoolId, data.data.hostname);
            saveUnifiedStorage();
          }
          break;
        case "unmount":
          if (data.data.hostname) {
            setCurrentSpoolId(null, data.data.hostname);
            saveUnifiedStorage();
          }
          break;
        default:
          console.debug(`[relay-bridge] 未知のフィラメントアクション: ${data.action}`);
      }
    } catch (e) {
      console.error("[relay-bridge] フィラメント操作エラー:", e);
    }
  });

  // 新規子クライアントからのスナップショット要求
  window.electronAPI.onRelayRequestSnapshot?.((data) => {
    const snapshot = _buildFullSnapshot();
    window.electronAPI.relaySendSnapshot(data.clientId, snapshot);
    console.debug(`[relay-bridge] スナップショット送信: ${data.clientId}`);
  });

  // 子クライアントからの操作モード昇格要求の PIN 検証（親側のみが PIN を保持）
  window.electronAPI.onRelayPromoteRequest?.((data) => {
    const result = verifyPromotePin(data.pin);
    window.electronAPI.relayPromoteResponse(data.clientId, result.granted, result.reason);
    console.info(`[relay-bridge] 昇格要求 ${data.clientId}: ${result.granted ? "許可" : "拒否(" + result.reason + ")"}`);
  });

  // カメラパススルー: 起動時に現在のエンドポイントマップを一度送る
  _syncCameraEndpoints();

  _initialized = true;
  console.info("[relay-bridge] 親側リレーブリッジ初期化完了");
  return true;
}

/**
 * 子クライアントの昇格 PIN を親の設定と照合する純関数。
 *
 * - 親に PIN 未設定（空）なら確認ダイアログのみで昇格許可（granted）。
 * - PIN 設定済みなら、入力 PIN が一致したときのみ許可。
 *   入力が空 → "pin-required"、不一致 → "pin-mismatch" を理由に拒否。
 *
 * @param {string} inputPin - 子が入力した PIN
 * @param {string} [configuredPin] - 親の設定 PIN（省略時は appSettings から取得）
 * @returns {{granted: boolean, reason: string}}
 */
export function verifyPromotePin(inputPin, configuredPin) {
  const pin = String(
    configuredPin != null ? configuredPin : (monitorData.appSettings.relayPromotePin || "")
  ).trim();
  if (!pin) {
    return { granted: true, reason: "" };           // PIN 未設定 → 許可
  }
  const entered = String(inputPin == null ? "" : inputPin).trim();
  if (!entered) {
    return { granted: false, reason: "pin-required" };
  }
  if (entered === pin) {
    return { granted: true, reason: "" };
  }
  return { granted: false, reason: "pin-mismatch" };
}

/**
 * connectionTargets からカメラパススルー用の
 * `{ [hostname]: { ip, port } }` マップを構築する純関数。
 *
 * - ip は dest("IP:PORT") の先頭コロンより前を採用。
 * - port は target.cameraPort → 既定 cameraPort → 8080 の優先順。
 * - hostname が未解決（空）のターゲットはキーにできないためスキップする。
 * - 同一 hostname が複数あれば後勝ち（DHCP統合後は基本1件）。
 *
 * @param {Array<{dest?: string, hostname?: string, cameraPort?: number}>} targets - 接続先リスト
 * @param {number} [defaultCameraPort=8080] - 既定カメラポート（appSettings.cameraPort）
 * @returns {Object<string, {ip: string, port: number}>}
 */
export function buildCameraEndpoints(targets, defaultCameraPort = 8080) {
  const map = {};
  if (!Array.isArray(targets)) return map;
  for (const t of targets) {
    const hostname = (t && t.hostname || "").trim();
    if (!hostname) continue;                       // 未解決ホストはキーにできない
    const dest = (t && t.dest || "").trim();
    const ip = dest.split(":")[0].trim();
    if (!ip) continue;                             // IP 不明は転送不可
    const port = (t && t.cameraPort) || defaultCameraPort || 8080;
    map[hostname] = { ip, port };
  }
  return map;
}

/**
 * 現在の appSettings からカメラ／画像パススルー用エンドポイントマップを構築し、
 * 前回送信時から変化していれば（簡易ハッシュ比較）メインプロセスへ送る。
 * 親(Electron)以外、または preload に setCameraEndpoints が無ければ何もしない。
 *
 * - buildCameraEndpoints は純関数（{ip, port}）のまま保ち、
 *   画像パススルー用の httpPort はここで host ごとに付与する。
 * - httpPort は getHttpPort(hostname)（dashboard_connection.js）と一致させる。
 *   これは親が自分の画像URL（http://ip:httpPort/downloads/...）で使うポートと同じ。
 * - 変更検出ハッシュは httpPort 込みで取る（ポート変更時も再送される）。
 *
 * @private
 * @returns {void}
 */
function _syncCameraEndpoints() {
  if (!window.electronAPI?.setCameraEndpoints) return;
  const map = buildCameraEndpoints(
    monitorData.appSettings.connectionTargets || [],
    monitorData.appSettings.cameraPort || 8080
  );
  // 画像パススルー用 httpPort を host ごとに付与（builder は pure のまま）。
  for (const hostname of Object.keys(map)) {
    map[hostname].httpPort = getHttpPort(hostname);
  }
  const hash = _quickHash(map);
  if (hash === _prevCameraEpHash) return;          // 変化なし
  _prevCameraEpHash = hash;
  window.electronAPI.setCameraEndpoints(map);
}

/**
 * aggregator 更新後に呼び出す。dirty keys を収集してリレーにブロードキャストする。
 * aggregatorUpdate の末尾から毎サイクル（500ms）呼ばれるが、
 * 実際のブロードキャストは BROADCAST_INTERVAL_MS（500ms）に間引く。
 *
 * @returns {void}
 */
export function relayBroadcastIfNeeded() {
  if (!_initialized) return;

  const now = Date.now();
  if (now - _lastBroadcastMs < BROADCAST_INTERVAL_MS) return;
  _lastBroadcastMs = now;

  // カメラパススルー: 接続先（ホスト名解決/ポート変更）の変化を反映
  _syncCameraEndpoints();

  const delta = _buildDelta();
  if (!delta) return; // 変更なし

  window.electronAPI.relayBroadcast(delta);
}

/**
 * 現在の monitorData から per-host の変更分（delta）を構築する。
 *
 * @private
 * @returns {Object|null} 変更があればデルタオブジェクト、なければ null
 */
function _buildDelta() {
  const machinesDelta = {};
  const printStoresDelta = {};
  const fileInfosDelta = {};
  let hasChanges = false;

  for (const [hostname, machine] of Object.entries(monitorData.machines)) {
    if (hostname === PLACEHOLDER_HOSTNAME) continue;
    const sd = machine.storedData;
    if (!sd) continue;

    const prev = _prevSnapshot.get(hostname) || {};
    const hostDelta = {};

    for (const [key, field] of Object.entries(sd)) {
      const rawVal = field?.rawValue;
      if (rawVal !== prev[key]) {
        hostDelta[key] = rawVal;
        prev[key] = rawVal;
      }
    }

    if (Object.keys(hostDelta).length > 0) {
      machinesDelta[hostname] = hostDelta;
      hasChanges = true;
    }
    _prevSnapshot.set(hostname, prev);

    // 印刷履歴・現在ジョブの変更検出（印刷完了やスプール再割当てで変化）
    // 子（satellite/readonly）はプリンタ直結しないため、ここで配信しないと履歴が空になる
    const ps = machine.printStore;
    if (ps) {
      const psHash = _quickHash(ps.history, ps.current);
      if (psHash !== _prevPrintHash.get(hostname)) {
        _prevPrintHash.set(hostname, psHash);
        printStoresDelta[hostname] = {
          history: ps.history || [],
          current: ps.current || null
        };
        hasChanges = true;
      }
    }

    // ファイル一覧（_cachedFileInfo）の変更検出
    const fi = machine._cachedFileInfo;
    if (fi) {
      const fiHash = _quickHash(fi);
      if (fiHash !== _prevFileHash.get(hostname)) {
        _prevFileHash.set(hostname, fiHash);
        fileInfosDelta[hostname] = fi;
        hasChanges = true;
      }
    }
  }

  // 共有データの変更検出（簡易ハッシュ）
  let sharedDelta = null;
  const sharedHash = _quickHash(monitorData.filamentSpools, monitorData.hostSpoolMap);
  if (sharedHash !== _prevSharedHash) {
    _prevSharedHash = sharedHash;
    sharedDelta = {
      filamentSpools: monitorData.filamentSpools,
      hostSpoolMap: monitorData.hostSpoolMap
    };
    hasChanges = true;
  }

  if (!hasChanges) return null;

  const delta = { machines: machinesDelta, shared: sharedDelta };
  if (Object.keys(printStoresDelta).length > 0) delta.printStores = printStoresDelta;
  if (Object.keys(fileInfosDelta).length > 0) delta.fileInfos = fileInfosDelta;
  return delta;
}

/**
 * フルスナップショットを構築する。新規子クライアント接続時に使用。
 *
 * @private
 * @returns {Object}
 */
function _buildFullSnapshot() {
  const machines = {};
  const printStores = {};
  const fileInfos = {};
  for (const [hostname, machine] of Object.entries(monitorData.machines)) {
    if (hostname === PLACEHOLDER_HOSTNAME) continue;
    const sd = machine.storedData;
    if (!sd) continue;

    const fields = {};
    for (const [key, field] of Object.entries(sd)) {
      fields[key] = field?.rawValue ?? null;
    }
    machines[hostname] = fields;

    // 印刷履歴・現在ジョブ（子が履歴パネルを表示するために必要）
    const ps = machine.printStore;
    if (ps && (ps.history?.length || ps.current)) {
      printStores[hostname] = {
        history: ps.history || [],
        current: ps.current || null
      };
    }
    // ファイル一覧（_cachedFileInfo は揮発。接続時に取得した最新を渡す）
    if (machine._cachedFileInfo) {
      fileInfos[hostname] = machine._cachedFileInfo;
    }
  }

  return {
    machines,
    printStores,
    fileInfos,
    filamentSpools: monitorData.filamentSpools,
    hostSpoolMap: monitorData.hostSpoolMap,
    appSettings: {
      connectionTargets: monitorData.appSettings.connectionTargets || []
    }
  };
}

/**
 * 簡易ハッシュ（変更検出用）。
 * @private
 */
function _quickHash(...objs) {
  let h = 0;
  const str = JSON.stringify(objs);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return String(h);
}
