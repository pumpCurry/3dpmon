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
import { sendCommand } from "./dashboard_connection.js";

/** ブリッジ初期化済みフラグ */
let _initialized = false;

/** 前回ブロードキャスト時の各ホスト・各キーの rawValue スナップショット */
const _prevSnapshot = new Map();

/** 前回ブロードキャストした共有データのハッシュ（簡易変更検出） */
let _prevSharedHash = "";

/** ブロードキャスト間隔 (ms) — aggregator は 500ms、リレーは 1000ms */
const BROADCAST_INTERVAL_MS = 1000;

/** 最終ブロードキャスト時刻 */
let _lastBroadcastMs = 0;

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

  _initialized = true;
  console.info("[relay-bridge] 親側リレーブリッジ初期化完了");
  return true;
}

/**
 * aggregator 更新後に呼び出す。dirty keys を収集してリレーにブロードキャストする。
 * aggregatorUpdate の末尾から毎サイクル（500ms）呼ばれるが、
 * 実際のブロードキャストは BROADCAST_INTERVAL_MS（1000ms）に間引く。
 *
 * @returns {void}
 */
export function relayBroadcastIfNeeded() {
  if (!_initialized) return;

  const now = Date.now();
  if (now - _lastBroadcastMs < BROADCAST_INTERVAL_MS) return;
  _lastBroadcastMs = now;

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

  return { machines: machinesDelta, shared: sharedDelta };
}

/**
 * フルスナップショットを構築する。新規子クライアント接続時に使用。
 *
 * @private
 * @returns {Object}
 */
function _buildFullSnapshot() {
  const machines = {};
  for (const [hostname, machine] of Object.entries(monitorData.machines)) {
    if (hostname === PLACEHOLDER_HOSTNAME) continue;
    const sd = machine.storedData;
    if (!sd) continue;

    const fields = {};
    for (const [key, field] of Object.entries(sd)) {
      fields[key] = field?.rawValue ?? null;
    }
    machines[hostname] = fields;
  }

  return {
    machines,
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
