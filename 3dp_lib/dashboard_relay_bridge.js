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
 *   （filamentSpools / hostSpoolMap / mountHistory の共有状態を含む）
 * - 子（satellite）からのコマンド/フィラメント操作 RPC を受信し親側で実行
 * - 新規子クライアント接続時にフルスナップショットを送信
 *
 * 【公開関数一覧】
 * - {@link initRelayBridge}：ブリッジを初期化する
 * - {@link handleRelayFilamentAction}：子からのフィラメント操作 RPC を実行する
 * - {@link verifyPromotePin}：昇格 PIN を検証する
 * - {@link buildCameraEndpoints}：カメラパススルー用エンドポイントを構築する
 * - {@link relayBroadcastIfNeeded}：変更があれば子へデルタ配信する
 *
 * @version 1.390.1110 (PR #380)
 * @since   1.390.820 (PR #367)
 * @lastModified 2026-06-12 12:00:00
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

/** 前回ブロードキャストした mountHistory（ADR-0004 台帳）のハッシュ（変更検出） */
let _prevMountHash = "";

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
    await handleRelayFilamentAction(data.action, data.data || {});
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
 * 子（satellite）から中継されたフィラメント操作を親側で実行する。
 *
 * 【詳細説明】
 * - サテライトはスプール状態をローカル変更せず、操作を本ハンドラへ RPC 委譲する。
 *   実行結果は次回 relay-delta（filamentSpools/hostSpoolMap/mountHistory 全置換）で
 *   全子クライアントへ還流する。
 * - switch が操作のホワイトリストを兼ねる（未知 action は無視してログのみ）。
 * - serialNo 採番・プリセット在庫消費などの不可逆リソースは必ず親側で消費される
 *   （サテライトでローカル実行するとカウンタが分岐し台帳が壊れるため）。
 *
 * @function handleRelayFilamentAction
 * @param {string} action - 操作種別
 *   ("mount" | "unmount" | "addSpoolFromPreset" | "mountNewSpoolFromPreset" |
 *    "updateSpool" | "deleteSpool" | "restoreSpool" |
 *    "confirmInferredSpool" | "revertInferredSpool")
 * @param {Object} payload - 操作データ（action ごとのペイロード）
 * @returns {Promise<void>} - 実行完了で解決（失敗時もログのみで解決）
 */
export async function handleRelayFilamentAction(action, payload) {
  // フィラメント操作は動的インポートで循環参照回避
  try {
    const spoolMod = await import("./dashboard_spool.js");
    const { saveUnifiedStorage } = await import("./dashboard_storage.js");
    switch (action) {
      case "mount":
        if (payload.spoolId && payload.hostname) {
          spoolMod.setCurrentSpoolId(payload.spoolId, payload.hostname);
          saveUnifiedStorage();
        }
        break;
      case "unmount":
        if (payload.hostname) {
          spoolMod.setCurrentSpoolId(null, payload.hostname);
          saveUnifiedStorage();
        }
        break;
      case "addSpoolFromPreset":
        // 新品開封（登録のみ・装着なし）。在庫消費・serialNo 採番は親側で実行
        if (payload.preset) {
          spoolMod.addSpoolFromPreset(payload.preset, payload.override || {});
          saveUnifiedStorage();
        }
        break;
      case "mountNewSpoolFromPreset":
        // 新品開封して装着（addSpoolFromPreset + setCurrentSpoolId の複合操作）
        if (payload.preset && payload.hostname) {
          spoolMod.mountNewSpoolFromPreset(payload.preset, payload.override || {}, payload.hostname);
          saveUnifiedStorage();
        }
        break;
      case "updateSpool":
        // スプール編集（残量修正・お気に入り等）
        if (payload.id && payload.patch && typeof payload.patch === "object") {
          spoolMod.updateSpool(payload.id, payload.patch);
        }
        break;
      case "deleteSpool":
        if (payload.id) {
          spoolMod.deleteSpool(payload.id, payload.hostname);
        }
        break;
      case "restoreSpool":
        if (payload.id) {
          spoolMod.restoreSpool(payload.id);
        }
        break;
      case "confirmInferredSpool":
        // ADR-0005 P6: 暫定推定スプールの確定（serialNo 採番・在庫消費は親のみ）
        if (payload.id) {
          spoolMod.confirmInferredSpool(payload.id);
        }
        break;
      case "revertInferredSpool":
        // ADR-0005 P6: 暫定推定スプールの取消（旧スプール完全復元）
        if (payload.id) {
          spoolMod.revertInferredSpool(payload.id);
        }
        break;
      default:
        console.debug(`[relay-bridge] 未知のフィラメントアクション: ${action}`);
    }
  } catch (e) {
    console.error("[relay-bridge] フィラメント操作エラー:", e);
  }
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
  const targets = monitorData.appSettings.connectionTargets || [];
  const defaultCam = monitorData.appSettings.cameraPort || 8080;
  const map = {};
  for (const t of targets) {
    const dest = (t?.dest || "").trim();
    const ip = dest.split(":")[0].trim();
    if (!ip) continue;                              // IP 不明は転送不可
    const hostname = (t?.hostname || "").trim();
    const label = (t?.label || "").trim();
    // machine 解決（Moonraker はキーが IP のままのことがあるため hostname/IP 双方で探す）
    const machine = (hostname && monitorData.machines?.[hostname])
      || monitorData.machines?.[ip] || null;
    let port = (t?.cameraPort) || defaultCam || 8080;
    let snapshotPath = "/?action=snapshot";         // K1 既定（mjpg-streamer）
    // ★ K: Moonraker は機器申告のスナップショットURL（/webcam/?action=snapshot 等）から
    //   パス/ポートを採用する。子が機器へ直接到達せず親が代理取得するための解決値。
    const snapUrl = machine?._cameraSnapshotUrl;
    if (snapUrl) {
      try {
        const u = new URL(snapUrl);
        port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
        snapshotPath = (u.pathname || "/") + (u.search || "");
      } catch { /* 解析失敗時は K1 既定のまま */ }
    }
    const ep = { ip, port, httpPort: getHttpPort(hostname || ip), snapshotPath };
    // 子の /relay-camera/{key} 要求がどの識別子でも当たるよう別名登録
    //   （表示名 label / 機器申告 hostname / IP / dest。先勝ちで上書きしない）
    for (const key of [hostname, label, ip, dest]) {
      if (key && !map[key]) map[key] = ep;
    }
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
      // ★【重篤・親CPU飽和修正】従来は全履歴(最大1500件×機器数)を毎500ms JSON.stringify して
      //   ハッシュ化しており、長時間稼働で履歴が積もると親のメインスレッドを飽和→aggregator
      //   (500ms)が starve され状態/グラフ更新が数分に1回まで低下していた。
      //   全件 stringify をやめ、O(1) の安価な署名（件数＋末尾エントリ＋現在ジョブの要点）で
      //   変化検出する（新規完了/現在ジョブ変化/末尾の帰属変更を捕捉）。
      const hist = ps.history || [];
      const last = hist.length ? hist[hist.length - 1] : null;
      const cur = ps.current || null;
      const psSig = `${hist.length}|${last?.id ?? ""}|${last?.materialUsedMm ?? last?.usagematerial ?? ""}|`
        + `${last?.printfinish ?? ""}|${last?.filamentId ?? ""}|${last?.observed ?? ""}|`
        + `${cur?.id ?? ""}|${cur?.materialUsedMm ?? ""}|${cur?.filamentId ?? ""}`;
      if (psSig !== _prevPrintHash.get(hostname)) {
        _prevPrintHash.set(hostname, psSig);
        printStoresDelta[hostname] = { history: hist, current: cur };
        hasChanges = true;
      }
    }

    // ファイル一覧（_cachedFileInfo）の変更検出（同様に全件 stringify を避ける）
    const fi = machine._cachedFileInfo;
    if (fi) {
      const ents = fi.entries || [];
      const fl = ents[ents.length - 1];
      const fiSig = `${fi.totalNum ?? ""}|${ents.length}|${ents[0]?.filename ?? ""}|`
        + `${fl?.filename ?? ""}|${String(fl?.mtime ?? "")}`;
      if (fiSig !== _prevFileHash.get(hostname)) {
        _prevFileHash.set(hostname, fiSig);
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

  // mountHistory（ADR-0004 装着台帳）の変更検出。
  // 印刷中は filamentSpools が毎 tick 変化するのに対し、台帳は装着/取外し時のみ
  // 変化するため別ハッシュで検出し、変化時のみ送る（転送量の無駄を防ぐ）。
  // 子はこれを受けてスプール解析・台帳由来の表示を親と一致させる。
  const mountHash = _quickHash(monitorData.mountHistory || []);
  if (mountHash !== _prevMountHash) {
    _prevMountHash = mountHash;
    sharedDelta = sharedDelta || {};
    sharedDelta.mountHistory = monitorData.mountHistory || [];
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
    mountHistory: monitorData.mountHistory || [],
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
