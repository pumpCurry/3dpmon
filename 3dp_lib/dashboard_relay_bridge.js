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
 *   （filamentSpools / hostSpoolMap / mountHistory / recovery 診断の共有状態を含む）
 * - 子（satellite）からのコマンド/フィラメント操作 RPC を受信し親側で実行
 * - 子（satellite）からの O5 inferred candidate decision request を親側で実行
 * - O6 recovery / repair 操作の監査状態を子へ read-only 配信する
 * - 新規子クライアント接続時にフルスナップショットを送信
 *
 * 【公開関数一覧】
 * - {@link initRelayBridge}：ブリッジを初期化する
 * - {@link handleRelayFilamentAction}：子からのフィラメント操作 RPC を実行する
 * - {@link verifyPromotePin}：昇格 PIN を検証する
 * - {@link buildCameraEndpoints}：カメラパススルー用エンドポイントを構築する
 * - {@link relayBroadcastIfNeeded}：変更があれば子へデルタ配信する
 *
 * @version 1.390.1279 (PR #426)
 * @since   1.390.820 (PR #367)
 * @lastModified 2026-08-04 11:50:46
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData, PLACEHOLDER_HOSTNAME } from "./dashboard_data.js";
import { sendCommand, getHttpPort } from "./dashboard_connection.js";
import { extractHost } from "./dashboard_target_identity.js";
import { wallNowMs } from "./dashboard_time.js";

/** ブリッジ初期化済みフラグ */
let _initialized = false;

/** 前回ブロードキャスト時の各ホスト・各キーの rawValue スナップショット */
const _prevSnapshot = new Map();

/** 前回ブロードキャストした共有データのハッシュ（簡易変更検出） */
let _prevSharedHash = "";

/** 前回ブロードキャストした mountHistory（ADR-0004 台帳）のハッシュ（変更検出） */
let _prevMountHash = "";

/** 前回ブロードキャストした pendingUnattributedUsage（未帰属消費 隔離領域）のハッシュ（変更検出） */
let _prevPendingHash = "";

/** 前回ブロードキャストした inferredCandidateStore（オフライン推定候補）のハッシュ（変更検出） */
let _prevInferredCandidateHash = "";

/** 前回ブロードキャストした recovery / repair 診断状態のハッシュ（変更検出） */
let _prevRecoveryHash = "";

/** 前回ブロードキャストした ItemKeeper 設定のハッシュ（変更検出） */
let _prevIkHash = "";

/** 前回ブロードキャストした業務タイムゾーン（変更検出）。undefined=未送信 */
let _prevBizTz;

/** 前回ブロードキャストした負残量表示モード（変更検出）。undefined=未送信 */
let _prevNegativeRemainingDisplayMode;

/**
 * 負残量表示モードを親子同期用の正規値へ変換する。
 *
 * @private
 * @param {*} value - appSettings に保存された表示モード。
 * @returns {string} `"show-negative"` または `"clamp-zero"`。
 */
function _normalizeNegativeRemainingDisplayMode(value) {
  return value === "clamp-zero" ? "clamp-zero" : "show-negative";
}

/**
 * 前回ブロードキャストしたフィラメント補助ドメイン（在庫・プリセット・
 * 切れ文脈・serialCounter・使用履歴）のハッシュ（変更検出）。
 */
let _prevAuxHash = "";

/**
 * 非冪等（採番・在庫消費・一括import＝再実行で二重追加になり得る）フィラメント操作。
 * 親側 opId 重複排除の対象（レビュー指摘#3で importUserPresets を追加）。
 */
const _NON_IDEMPOTENT_RELAY = new Set([
  "addSpool", "addSpoolFromPreset", "mountNewSpoolFromPreset", "confirmInferredSpool",
  "confirmInferredCandidate", "rejectInferredCandidate", "reassignInferredCandidate",
  "undoInferredCandidateDecision",
  "importUserPresets"
]);

/** 親が処理済みの opId（opId → ts）。同一操作の再配信を二重実行しないための記録。 */
const _recentRelayOpIds = new Map();

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

  // ★ satellite からの ItemKeeper 設定変更を親で受領 → 親が唯一の設定元として確定保存。
  //   確定後は次回 relay-delta(appSettingsItemkeeper)で全子へ還流しミラーが揃う。
  window.electronAPI.onRelaySettings?.((data) => {
    const ik = data?.payload?.itemkeeper;
    if (ik && typeof ik === "object") {
      console.debug("[relay-bridge] satellite から ItemKeeper 設定受信");
      window.itemKeeperIntegration?.applyRemoteSettings?.(ik);
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
 * 子（satellite）から中継されたフィラメント操作を親側で実行する。
 *
 * 【詳細説明】
 * - サテライトはスプール状態をローカル変更せず、操作を本ハンドラへ RPC 委譲する。
 *   実行結果は次回 relay-delta（filamentSpools/hostSpoolMap/mountHistory 全置換）で
 *   全子クライアントへ還流する。
 * - switch が操作のホワイトリストを兼ねる（未知 action は無視してログのみ）。
 * - serialNo 採番・プリセット在庫消費などの不可逆リソースは必ず親側で消費される
 *   （サテライトでローカル実行するとカウンタが分岐し台帳が壊れるため）。
 * - O5 inferred candidate decision は親の Decision Core だけが実行し、子は request のみを送る。
 *
 * @function handleRelayFilamentAction
 * @param {string} action - 操作種別
 *   ("mount" | "unmount" | "addSpool" | "addSpoolFromPreset" | "mountNewSpoolFromPreset" |
 *    "updateSpool" | "deleteSpool" | "restoreSpool" |
 *    "confirmInferredSpool" | "revertInferredSpool" | "resolveFilamentEvent" |
 *    "confirmInferredCandidate" | "rejectInferredCandidate" | "reassignInferredCandidate" |
 *    "undoInferredCandidateDecision" |
 *    "setInventoryQuantity" | "adjustInventory" | "setMinStockAlert" |
 *    "togglePresetVisibility" | "toggleBrandVisibility" | "togglePresetFavorite" |
 *    "addUserPreset" | "updateUserPreset" | "deleteUserPreset")
 * @param {Object} payload - 操作データ（action ごとのペイロード）
 * @returns {Promise<void>} - 実行完了で解決（失敗時もログのみで解決）
 */
/**
 * 子から受けたプリセット開封 payload を親の正本プリセットへ解決する。
 *
 * ★ レビュー指摘(ChatGPT): 子はプリセット本体ではなく presetId を送る設計へ変更した。
 * 親は自身の getAllPresets（ビルトイン＋userPresets＝権威）から presetId を引く。
 * 見つからなければ孤児プリセット/在庫不整合を避けるため null を返し、呼び出し側は何もしない。
 * 旧クライアント互換のため payload.preset（本体）が来た場合のみフォールバックで受理する。
 *
 * @private
 * @param {{presetId?: string, preset?: Object}} payload - 開封ペイロード
 * @returns {Promise<?Object>} 解決したプリセット（未解決は null）
 */
async function _resolveRelayPreset(payload) {
  if (!payload) return null;
  let all = [];
  try {
    const presetMod = await import("./dashboard_filament_presets.js");
    all = presetMod.getAllPresets({ includeHidden: true }) || [];
  } catch (e) {
    console.error("[relay-bridge] preset 解決失敗:", e);
  }
  // presetId 明示 → 親の正本から解決（見つからなければ孤児生成を避けるため null）
  if (payload.presetId) {
    return all.find(p => p && p.presetId === payload.presetId) || null;
  }
  // 後方互換（旧クライアントが preset 本体を送る場合）
  // ★ レビュー指摘#5: 本体をそのまま使わない。presetId を持つなら必ず親の正本へ置換し、
  //   未登録 presetId の本体は孤児プリセット化するため受理しない。presetId を持たない
  //   完全アドホックな本体のみ、そのまま受理する。
  if (payload.preset) {
    const pid = payload.preset.presetId;
    if (pid) return all.find(p => p && p.presetId === pid) || null;
    return payload.preset;
  }
  return null;
}

/**
 * O5 decision request の共通 options を親側の安全な形へ正規化する。
 *
 * 【詳細説明】
 * - Satellite からの clock 注入は受け付けず、親の Decision Core が `wallNowMs()` で監査時刻を採番する。
 * - actor は監査ログ用の表示情報に留め、未指定時は relay-satellite として記録する。
 *
 * @private
 * @function _relayDecisionOptions
 * @param {Object} payload - relay-filament payload。
 * @returns {{actor:string}} Decision Core へ渡す options。
 */
function _relayDecisionOptions(payload) {
  return {
    actor: payload?.actor || "relay-satellite"
  };
}

export async function handleRelayFilamentAction(action, payload) {
  // ★ レビュー指摘#1/#2/#3: 非冪等操作（採番・在庫消費・一括import）の opId 重複排除。
  //   子側 1.5 秒抑止だけでは、リトライやリレー再配信で同一操作が親へ2回届くと2回採番・
  //   2回在庫消費し得る。親は「処理開始前」に opId を予約し（完了後ではない＝ほぼ同時到着の
  //   2件を両方通さない）、既知 opId は実行しない。さらに同一 opId で action/payload 署名が
  //   異なる場合はクライアントの opId 再利用バグを隠さないよう警告する。
  if (_NON_IDEMPOTENT_RELAY.has(action) && payload && payload._opId) {
    const now = wallNowMs();
    const sig = `${action}:${JSON.stringify(payload)}`;
    const prev = _recentRelayOpIds.get(payload._opId);
    if (prev) {
      if (prev.sig !== sig) {
        console.warn(`[relay-bridge] 同一 opId で異なる action/payload（クライアントの opId 再利用の疑い）: ${payload._opId}`);
      } else {
        console.warn(`[relay-bridge] 重複 opId を無視: ${action} (${payload._opId})`);
      }
      return; // いずれも実行しない
    }
    // 処理（await）を始める前に予約する。
    _recentRelayOpIds.set(payload._opId, { sig, ts: now });
    if (_recentRelayOpIds.size > 200) {
      for (const [k, r] of _recentRelayOpIds) if (now - r.ts > 60000) _recentRelayOpIds.delete(k);
    }
  }
  // フィラメント操作は動的インポートで循環参照回避
  try {
    const spoolMod = await import("./dashboard_spool.js");
    const { saveUnifiedStorage } = await import("./dashboard_storage.js");
    switch (action) {
      case "mount":
        if (payload.spoolId && payload.hostname) {
          // ★ RR-4: 受信 RPC の _opId を交換操作の基底IDとして親の台帳追記へ伝播する。
          spoolMod.setCurrentSpoolId(payload.spoolId, payload.hostname, { operationId: payload._opId });
          saveUnifiedStorage();
        }
        break;
      case "unmount":
        if (payload.hostname) {
          spoolMod.setCurrentSpoolId(null, payload.hostname, { operationId: payload._opId });
          saveUnifiedStorage();
        }
        break;
      case "addSpool":
        // ★ 監査 P0(第2報): 子の新規スプール登録。serialNo 採番(spoolSerialCounter)は
        //   親のみで消費する（子は addSpool ガードで RPC 委譲済み）。
        if (payload.data && typeof payload.data === "object") {
          spoolMod.addSpool(payload.data, { inferred: !!payload.inferred });
          saveUnifiedStorage();
        }
        break;
      case "addSpoolFromPreset": {
        // 新品開封（登録のみ・装着なし）。在庫消費・serialNo 採番は親側で実行。
        // ★ レビュー指摘(ChatGPT): 子は presetId のみ送る。親が自身の正本から解決する
        //   （見つからなければ孤児生成を避けるため何もしない）。旧 payload.preset も後方互換で受理。
        const preset = await _resolveRelayPreset(payload);
        if (preset) {
          spoolMod.addSpoolFromPreset(preset, payload.override || {});
          saveUnifiedStorage();
        } else {
          console.warn(`[relay-bridge] addSpoolFromPreset: presetId 未解決のため無視: ${payload.presetId}`);
        }
        break;
      }
      case "mountNewSpoolFromPreset": {
        // 新品開封して装着（addSpoolFromPreset + setCurrentSpoolId の複合操作）
        const preset = await _resolveRelayPreset(payload);
        if (preset && payload.hostname) {
          spoolMod.mountNewSpoolFromPreset(preset, payload.override || {}, payload.hostname);
          saveUnifiedStorage();
        } else if (!preset) {
          console.warn(`[relay-bridge] mountNewSpoolFromPreset: presetId 未解決のため無視: ${payload.presetId}`);
        }
        break;
      }
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
      case "confirmInferredCandidate": {
        // O5C: Satellite からの Confirm request。親の Decision Core が候補検証・台帳反映・耐久保存を行う。
        if (payload.candidateHash) {
          const decisionMod = await import("./dashboard_inferred_candidate_decision.js");
          await decisionMod.confirmInferredCandidate(payload.candidateHash, _relayDecisionOptions(payload));
        }
        break;
      }
      case "rejectInferredCandidate": {
        // O5C: Reject は確定台帳には触れないが、candidate status は親権威 store でのみ遷移する。
        if (payload.candidateHash) {
          const decisionMod = await import("./dashboard_inferred_candidate_decision.js");
          await decisionMod.rejectInferredCandidate(payload.candidateHash, {
            ..._relayDecisionOptions(payload),
            reason: payload.reason,
            note: payload.note || ""
          });
        }
        break;
      }
      case "reassignInferredCandidate": {
        // O5C: Reassign は target spool への確定台帳反映を伴うため、親の Decision Core だけが実行する。
        if (payload.candidateHash && payload.targetSpoolId) {
          const decisionMod = await import("./dashboard_inferred_candidate_decision.js");
          await decisionMod.reassignInferredCandidate(
            payload.candidateHash,
            payload.targetSpoolId,
            _relayDecisionOptions(payload)
          );
        }
        break;
      }
      case "undoInferredCandidateDecision": {
        // O5D: Undo は O5 が反映した確定台帳だけを親権威で逆反映する。
        if (payload.candidateHash) {
          const decisionMod = await import("./dashboard_inferred_candidate_decision.js");
          await decisionMod.undoInferredCandidateDecision(payload.candidateHash, _relayDecisionOptions(payload));
        }
        break;
      }
      case "resolveFilamentEvent":
        // ★ 監査 P0(第2報): フィラメント切れ文脈の解決（reseat 等）を親で確定。
        //   結果は relay-delta の filamentEventContext で全子へ還流する。
        // ★ #2/#5: 子が見ていた evId と親の現在イベントが一致した場合のみ解決する。
        //   リレー経由の解決は evId 必須。evId 欠落時に hostname 一致へフォールバックすると、
        //   遅延 reseat が別イベントを誤解決する問題が旧データ経由で復活するため、安全側で拒否する
        //   （親画面での直接操作だけが expectedEvId=null の例外＝_resolveFilamentEventAuthoritative）。
        if (payload.host && payload.resolution && payload.evId) {
          const ledgerMod = await import("./dashboard_filament_ledger.js");
          ledgerMod.resolveFilamentEvent(payload.host, payload.resolution, { expectedEvId: payload.evId });
          saveUnifiedStorage();
        } else if (payload.host && payload.resolution) {
          console.warn(`[relay-bridge] resolveFilamentEvent: evId 欠落のためリレー解決を拒否(安全側): ${payload.host}`);
        }
        break;
      case "setInventoryQuantity":
      case "adjustInventory":
      case "setMinStockAlert": {
        // ★ 監査 P0(第2報): 在庫は親が唯一の権威。子の増減/設定を親で確定。
        //   inventory 関数は内部で saveUnifiedStorage を呼ぶ。
        const invMod = await import("./dashboard_filament_inventory.js");
        if (payload.modelId) {
          if (action === "setInventoryQuantity") invMod.setInventoryQuantity(payload.modelId, payload.quantity);
          else if (action === "adjustInventory") invMod.adjustInventory(payload.modelId, payload.delta);
          else invMod.setMinStockAlert(payload.modelId, payload.threshold);
        }
        break;
      }
      case "togglePresetVisibility":
      case "toggleBrandVisibility":
      case "togglePresetFavorite":
      case "addUserPreset":
      case "updateUserPreset":
      case "deleteUserPreset":
      case "importUserPresets": {
        // ★ 監査 P0(第2報): カスタムプリセット/表示・お気に入りは親が唯一の権威。
        //   preset 関数は saveUnifiedStorage を呼ばないため、確定後に明示保存する。
        const presetMod = await import("./dashboard_filament_presets.js");
        if (action === "togglePresetVisibility" && payload.presetId) presetMod.togglePresetVisibility(payload.presetId);
        else if (action === "toggleBrandVisibility" && payload.brand) presetMod.toggleBrandVisibility(payload.brand);
        else if (action === "togglePresetFavorite" && payload.presetId) presetMod.togglePresetFavorite(payload.presetId);
        else if (action === "addUserPreset" && payload.data) presetMod.addUserPreset(payload.data);
        else if (action === "updateUserPreset" && payload.presetId) presetMod.updateUserPreset(payload.presetId, payload.changes || {});
        else if (action === "deleteUserPreset" && payload.presetId) presetMod.deleteUserPreset(payload.presetId);
        else if (action === "importUserPresets" && typeof payload.jsonStr === "string") presetMod.importUserPresets(payload.jsonStr, payload.opts || {});
        saveUnifiedStorage();
        break;
      }
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
    const ip = extractHost(dest);
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
    const ip = extractHost(dest);
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

  const now = wallNowMs();
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
      // ★ 監査§6: 履歴 revision(_historyRev) を署名に含める。末尾サンプルでは拾えない
      //   履歴中間の filamentInfo 編集・分割 upsert・reconcile 等（saveHistory 経由の実変更）を
      //   子へ確実に伝播させる。rev は savePrintHistory が実書き換え時のみ加算する。
      const psSig = `${ps._historyRev ?? ""}|${hist.length}|${last?.id ?? ""}|${last?.materialUsedMm ?? last?.usagematerial ?? ""}|`
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

  // ★ Phase4: pendingUnattributedUsage（無効jobId等で未帰属となった消費の隔離領域）の
  //   変更検出。子（サテライト/読み取り専用）でも「未確認の消費」を親と一致して可視化する
  //   ため、変化時のみ全置換で配信する（mountHistory と同じく低頻度変化＝別ハッシュ）。
  const pendingHash = _quickHash([
    monitorData.pendingUnattributedUsage || [],
    monitorData.pendingUnattributedUsageArchive || {}
  ]);
  if (pendingHash !== _prevPendingHash) {
    _prevPendingHash = pendingHash;
    sharedDelta = sharedDelta || {};
    sharedDelta.pendingUnattributedUsage = monitorData.pendingUnattributedUsage || [];
    sharedDelta.pendingUnattributedUsageArchive = monitorData.pendingUnattributedUsageArchive || {};
    hasChanges = true;
  }

  // ★ #412-O4: O2/O3 の分類結果・推定 debit を子へミラーする。
  //   生の 5000 件観測ではなく、親が耐久保存した candidate store だけを同期する。
  const inferredCandidateHash = _quickHash(monitorData.inferredCandidateStore || {});
  if (inferredCandidateHash !== _prevInferredCandidateHash) {
    _prevInferredCandidateHash = inferredCandidateHash;
    sharedDelta = sharedDelta || {};
    sharedDelta.inferredCandidateStore = monitorData.inferredCandidateStore || {};
    hasChanges = true;
  }

  // ★ #418: recovery / repair 診断は Parent が権威を持つ。
  //   Candidate Center の read-only 診断を Satellite でも親と一致させるため、
  //   candidate store とは別ハッシュで低頻度同期する。
  const recoveryHash = _quickHash(
    monitorData.inferredDecisionRecoveryRequired || null,
    monitorData.inferredRecoveryOperationRecoveryRequired || null,
    monitorData.inferredRecoveryEvents || [],
    monitorData.ledgerRepairRequired || {},
    monitorData.mountHistoryRejectedEvents || []
  );
  if (recoveryHash !== _prevRecoveryHash) {
    _prevRecoveryHash = recoveryHash;
    sharedDelta = sharedDelta || {};
    sharedDelta.inferredDecisionRecoveryRequired = monitorData.inferredDecisionRecoveryRequired || null;
    sharedDelta.inferredRecoveryOperationRecoveryRequired = monitorData.inferredRecoveryOperationRecoveryRequired || null;
    sharedDelta.inferredRecoveryEvents = monitorData.inferredRecoveryEvents || [];
    sharedDelta.ledgerRepairRequired = monitorData.ledgerRepairRequired || {};
    sharedDelta.mountHistoryRejectedEvents = monitorData.mountHistoryRejectedEvents || [];
    hasChanges = true;
  }

  // ★ 監査 P0(第2報): フィラメント補助ドメイン（在庫・カスタムプリセット・表示/
  //   お気に入り・切れ文脈・serialCounter・使用履歴）の変更検出。従来は
  //   filamentSpools/hostSpoolMap/mountHistory のみ共有していたため、これらが親子で
  //   別管理になり在庫・プリセット・集計・切れ状態が食い違っていた。親が唯一の権威で、
  //   装着系より低頻度な変化なので別ハッシュで検出し変化時のみ送る（転送量抑制）。
  // ★ CPU配慮: usageHistory は数千件に成長し得るため全文ハッシュ（JSON.stringify）を毎tick
  //   実行しない（近年の履歴全文 stringify 廃止＝親メインスレッド飽和対策に逆行するため）。
  //   追記主体のログなので「件数＋末尾エントリのみ」の O(1) 署名で変化検出する。
  //   在庫/プリセット/切れ文脈は小規模なので従来どおり全文ハッシュで足りる。
  const uh = monitorData.usageHistory || [];
  const uhLast = uh.length ? uh[uh.length - 1] : null;
  // usageHistoryRev は一括インポート等の非追記変更で加算され、件数＋末尾では拾えない
  // 中間レコードの変化を確実に検出させる（レビュー指摘#4）。
  const usageSig = `${uh.length}|${monitorData.usageHistoryRev ?? 0}|${uhLast ? JSON.stringify(uhLast) : ""}`;
  const auxHash = _quickHash(
    monitorData.filamentInventory || [],
    monitorData.userPresets || [],
    monitorData.hiddenPresets || [],
    monitorData.favoritePresets || [],
    monitorData.filamentEventContext || {},
    monitorData.spoolSerialCounter ?? 0
  ) + "|" + usageSig;
  if (auxHash !== _prevAuxHash) {
    _prevAuxHash = auxHash;
    sharedDelta = sharedDelta || {};
    sharedDelta.filamentInventory = monitorData.filamentInventory || [];
    sharedDelta.userPresets = monitorData.userPresets || [];
    sharedDelta.hiddenPresets = monitorData.hiddenPresets || [];
    sharedDelta.favoritePresets = monitorData.favoritePresets || [];
    sharedDelta.filamentEventContext = monitorData.filamentEventContext || {};
    sharedDelta.spoolSerialCounter = monitorData.spoolSerialCounter ?? 0;
    sharedDelta.usageHistory = monitorData.usageHistory || [];
    hasChanges = true;
  }

  // ★ ItemKeeper 設定の変更検出（親で変更 or satellite からの逆反映時のみ送る）。
  //   子はこれを受けて自身の itemKeeperIntegration を親設定で再読込（ミラー）する。
  const ikHash = _quickHash(monitorData.appSettings.itemkeeper || {});
  if (ikHash !== _prevIkHash) {
    _prevIkHash = ikHash;
    sharedDelta = sharedDelta || {};
    sharedDelta.appSettingsItemkeeper = monitorData.appSettings.itemkeeper || {};
    hasChanges = true;
  }

  // ★ レビュー(時計衛生): 業務タイムゾーンの変更を子へ配信（親権威）。
  const bizTz = monitorData.appSettings.businessTimeZone ?? null;
  if (bizTz !== _prevBizTz) {
    _prevBizTz = bizTz;
    sharedDelta = sharedDelta || {};
    sharedDelta.appSettingsBusinessTimeZone = bizTz;
    hasChanges = true;
  }

  // ★ Signed remaining: 負残量表示設定は Parent が権威を持ち、Satellite へミラーする。
  const negativeMode = _normalizeNegativeRemainingDisplayMode(
    monitorData.appSettings.negativeRemainingDisplayMode
      ?? monitorData.appSettings.negativeRemainingDisplay
      ?? monitorData.appSettings.filamentRemainingDisplayMode
  );
  if (negativeMode !== _prevNegativeRemainingDisplayMode) {
    _prevNegativeRemainingDisplayMode = negativeMode;
    sharedDelta = sharedDelta || {};
    sharedDelta.appSettingsNegativeRemainingDisplayMode = negativeMode;
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
    // ★ Phase4/P0-1: 未帰属消費の隔離領域とアーカイブも同梱（親=権威、子は読み取り専用ミラー）。
    pendingUnattributedUsage: monitorData.pendingUnattributedUsage || [],
    pendingUnattributedUsageArchive: monitorData.pendingUnattributedUsageArchive || {},
    // ★ #412-O4: 子は分類済み candidate と推定量だけを受け取り、生観測は受け取らない。
    inferredCandidateStore: monitorData.inferredCandidateStore || {},
    // ★ #418: Candidate Center の Recovery / repair 診断も親権威で子へ同梱する。
    inferredDecisionRecoveryRequired: monitorData.inferredDecisionRecoveryRequired || null,
    inferredRecoveryOperationRecoveryRequired: monitorData.inferredRecoveryOperationRecoveryRequired || null,
    inferredRecoveryEvents: monitorData.inferredRecoveryEvents || [],
    ledgerRepairRequired: monitorData.ledgerRepairRequired || {},
    mountHistoryRejectedEvents: monitorData.mountHistoryRejectedEvents || [],
    // ★ 監査 P0(第2報): フィラメント補助ドメインをスナップショットにも同梱（親=権威）。
    filamentInventory: monitorData.filamentInventory || [],
    userPresets: monitorData.userPresets || [],
    hiddenPresets: monitorData.hiddenPresets || [],
    favoritePresets: monitorData.favoritePresets || [],
    filamentEventContext: monitorData.filamentEventContext || {},
    spoolSerialCounter: monitorData.spoolSerialCounter ?? 0,
    usageHistory: monitorData.usageHistory || [],
    appSettings: {
      connectionTargets: monitorData.appSettings.connectionTargets || [],
      // ★ ItemKeeper 連携設定を子へミラー（親が唯一の設定元・送信元）。
      //   子(readonly=閲覧専用ミラー / satellite=編集可だが変更は relay-settings で親へ逆反映)。
      itemkeeper: monitorData.appSettings.itemkeeper || {},
      // ★ レビュー(時計衛生): 業務タイムゾーン(親権威)を子へミラー（日次/月次集計の既定ゾーン）。
      businessTimeZone: monitorData.appSettings.businessTimeZone ?? null,
      // 旧履歴移行の固定基準ゾーンも子へミラー（親の tz-less 旧履歴を子が同一解釈するため）。
      legacyHistoryTimeZone: monitorData.appSettings.legacyHistoryTimeZone ?? null,
      // 負残量表示は Parent 権威でミラーする。台帳値は filamentSpools の signed 値をそのまま使う。
      negativeRemainingDisplayMode: _normalizeNegativeRemainingDisplayMode(
        monitorData.appSettings.negativeRemainingDisplayMode
          ?? monitorData.appSettings.negativeRemainingDisplay
          ?? monitorData.appSettings.filamentRemainingDisplayMode
      )
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
