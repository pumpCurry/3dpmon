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
 * @version 1.390.1580 (PR #440)
 * @since   1.390.193 (PR #86)
 * @lastModified 2026-09-01 13:38:00
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

// プリセットフィラメント情報を取り込む
import { FILAMENT_PRESETS } from "./dashboard_filament_presets.js";
import { createEmptyMaterialAccountingSpoolMountStore } from "./printer_core/dashboard_material_accounting_mount_store.js";


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
 *     notificationSettings: Record<string, any>,
 *     negativeRemainingDisplayMode: string
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
    chartWindowMin: 15,   // 温度グラフの保持/表示時間枠（分）。古い点は破棄しメモリ無制限化を防ぐ
    logLevel: "info",
    logReceivedRaw: false, // 受信生ログをログパネルに流す（K1系のみ）。既定OFF=CPU/ログ汚染防止

    autoConnect: true,
    // ★ wsDest は v2.2.0 で完全削除済み。connectionTargets が唯一の接続先リスト。
    connectionTargets: [],  // 複数接続先リスト [{dest, color?, label?}]
    showHostTag: true,      // パネルヘッダーにホスト名を表示する
    cameraToggle: false,  // カメラ ON/OFF
    cameraPort: 8080,     // カメラストリームポート（デフォルト。per-host は connectionTargets.cameraPort）
    httpPort: 80,         // HTTP ポート（デフォルト。印刷履歴・ファイル取得用）
    relayPromotePin: "",  // リレー操作モード昇格PIN（空=確認のみ）。親でのみ設定・参照可
    filamentUnit: "m",    // 使用量表示単位 "m" | "mm"（印刷履歴・ファイル一覧共通トグル）
    negativeRemainingDisplayMode: "show-negative", // 負残量の表示方針 "show-negative" | "clamp-zero"。旧値 "show"/"signed" は読取互換
    // ★ レビュー(時計衛生 P1): 日次/月次集計の業務タイムゾーン（IANA）。親権威の永続設定で、
    //   リレーで子へミラーする。親起動時に未設定なら解決済みローカルへ確定・保存する。
    businessTimeZone: null,
    // ★ レビュー(時計衛生 P2 item5): offset なし旧履歴を epoch へ移行する際の固定基準ゾーン。
    //   一度確定したら変更しない（businessTimeZone を後から変えても旧文字列を再解釈させないため）。
    legacyHistoryTimeZone: null,
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
  /**
   * usageHistory の非追記的変更（一括インポート等）を示す改訂番号。
   * ★ レビュー指摘#4: リレーの usageHistory 変更検出は「件数＋末尾」の O(1) 署名だが、
   *   同件数・同末尾で中間レコードだけが変わる一括インポートを検出できない。import 完了時に
   *   本 rev を加算し、署名へ含めることで子への伝播を保証する。
   * @type {number}
   */
  usageHistoryRev: 0,
  filamentInventory: [],
  /**
   * フィラメント装着履歴（追記専用イベントログ。ADR-0004）。
   * remainingLengthMm の権威。usageHistory のロールオーバーとは別ストアに置き、
   * 装着/取外しイベントを保持する。MountEvent[]:
   *   { evId, ts, type:"mount"|"unmount", host, spoolId,
   *     anchorRemainingMm?, sinceJobId?(mount), untilJobId?(unmount) }
   * @type {Array<Object>}
   */
  mountHistory: [],
  /**
   * mountHistory の親権威・単調増加 seq の高水位番号（Q1/Q3）。
   * appendMountEvent 等が採番するたびに更新される。子はミラーのみ。
   * @type {number}
   */
  mountHistorySeq: 0,
  /**
   * ★ #410-9: import/restore 時に参照不整合と判定された mount イベントの隔離領域。
   * 有効な projection へは適用せず（corrupt 化を防ぐ）、元データは失わない。
   * 各要素: { event, reason }
   * @type {Array<Object>}
   */
  mountHistoryRejectedEvents: [],
  /**
   * ★ #411-O1(Option4): オフライン推定帰属の前段となる「観測 watermark」。
   * アプリ稼働中に per-host で「見えていた状態」を記録し、再起動後に
   * (現在の完了履歴 − 前回観測済み集合) でオフライン新規ジョブを特定する材料にする。
   * 本フィールドは read-only 運用の追加専用で、安全基盤（completionObservationId/
   * pendingUnattributedUsage/mountHistory/usedLengthLog 等）には一切影響しない。
   * host -> { observedAtEpochMs, mountedSpoolId, mountIntervalId, printerIdentity,
   *           seenCompletedJobIds:Array<number>, historyCount }
   * @type {Object.<string, Object>}
   */
  hostObservationWatermark: {},
  /**
   * ★ #411-O1: 現セッションの最新観測（baseline とは別スロット）。
   * recordHostObservation が更新し、オフライン窓評価まで baseline を上書きしない
   * （起動直後に停止前基準を消さないため）。
   * @type {Object.<string, Object>}
   */
  hostObservationCurrent: {},
  /**
   * ★ #412-O4: オフライン継続推定 candidate の親権威ストア。
   * O2/O3 で得た分類・推定 debit を、baseline commit 前に耐久保存するための領域。
   * 削除ではなく status 遷移と events 追記で監査可能にし、子へは分類結果と推定量のみ同期する。
   * hash -> { candidateHash, windowId, candidateSpoolId, observationKeys, usedMm, confidence, evidence,
   *           status, createdAt, updatedAt, resolvedAt, events:Array<Object> }
   * @type {Object.<string, Object>}
   */
  inferredCandidateStore: {},
  /**
   * ★ #417/O5D: O5 decision rollback 後の状態を耐久保存できなかった場合の復旧要求。
   * null なら通常状態。object の場合は新規 Confirm/Reject/Reassign/Undo を fail-closed で停止し、
   * O6 Recovery Operations で状態確認・再保存・解除を行う。
   * @type {?Object}
   */
  inferredDecisionRecoveryRequired: null,
  /**
   * ★ #424/O6D: O6 recovery operation 自体の rollback 状態を耐久保存できなかった場合の復旧要求。
   * null なら通常状態。object の場合は O5 decision と通常 O6 operation を fail-closed で停止し、
   * recovery 状態の再保存または operator 確認後の解除だけを許可する。
   * @type {?Object}
   */
  inferredRecoveryOperationRecoveryRequired: null,
  /**
   * ★ #420/O6A: recovery / repair 操作の監査 event。
   * decision recovery flag 解除、ledger repair flag 解除、隔離 mount event の archive などを追記し、
   * 復旧操作が通常の candidate decision と同様に追跡できるようにする。
   * @type {Array<Object>}
   */
  inferredRecoveryEvents: [],
  /**
   * ★ Phase2A: 有効な jobId が無いまま完了した消費の隔離領域。
   * 電源投入直後などで printStartTime が 0/null の「無効ID」ジョブは
   * 履歴・usedLengthLog・境界へ確定記録を作らず（過去全履歴の誤減算＝退行を防ぐ）、
   * 消費量だけを本領域に退避して失わないようにする。実IDが判明した時点で解決する。
   * 各要素: { host, spoolId, usedMm, startLen, reason, detectedAtEpochMs }
   * @type {Array<Object>}
   */
  pendingUnattributedUsage: [],
  /**
   * ★ P0-2: pendingUnattributedUsage の上限超過分を「黙って捨てず」集約保持する
   * per-host アーカイブ（件数・合計消費・期間）。詳細レコードは失うが総量は失わない。
   * host -> { count, totalUsedMm, totalEstimatedMm, firstAtEpochMs, lastAtEpochMs }
   * @type {Object.<string, Object>}
   */
  pendingUnattributedUsageArchive: {},
  /**
   * ★ RR-2: 台帳(mount区間)が ambiguous/corrupt で、交換時に旧区間を安全にクローズできなかった
   * ことを per-host に記録する（暗黙クローズせず修復要求を可視化）。
   * host -> { spoolId, status, detectedAtEpochMs }
   * @type {Object.<string, Object>}
   */
  ledgerRepairRequired: {},
  /**
   * ADR-0005: フィラメント切れ/一時停止イベントの状態文脈（per-host）。
   * キーはホスト名、値は recordFilamentEvent が記録する文脈オブジェクト。
   * 交換操作の遡及帰属（稼働中=ジョブ全体 / 一時停止=分割）判定に用いる。
   * @type {Object.<string, Object>}
   */
  filamentEventContext: {},
  /**
   * Gate 18.7: CFS/CFS-C/外部スプールの機器観測フィラメントストア。
   * これは3DPmon管理スプールの装着状態ではなく、Printer Core v3がread-onlyで見た
   * material source snapshot/change logである。hostSpoolMap / mountHistory / usageHistory の
   * 権威へ自動反映しない。
   * @type {{schemaVersion:number, byDeviceId:Object.<string, Object>}}
   */
  materialSourceObservations: { schemaVersion: 1, byDeviceId: {} },
  /**
   * Gate 18.9B: Universal MaterialSource移行dry-run journal。
   * READY/CANDIDATE/BLOCKEDの移行計画と検証証跡を保持するが、ここから
   * MaterialSource / SpoolMount / usage ledger の本番権威へ自動反映しない。
   * @type {{schemaVersion:number, authority:string, latestMigrationId:?string, byMigrationId:Object.<string, Object>, events:Array<Object>, retainedUnsupportedEntries:Array<Object>, invariants:Object}}
   */
  materialAccountingMigrationJournal: {
    schemaVersion: 1,
    authority: "migration-dry-run-journal",
    latestMigrationId: null,
    byMigrationId: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      activateUniversalWrites: false,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      migrationJournalIsEvidenceOnly: true,
    },
  },
  /**
   * Gate 18.9D-2: Universal MaterialSource移行shadow commit store。
   * prepared shadow transactionがdurable commitに成功した後のMaterialSource/SpoolMount
   * snapshotとmigration lifecycleを保持する。これはまだledger debitやlegacy cutover sealの
   * authorityではなく、再起動後のshadow observation/retryを復元するための永続storeである。
   * @type {{schemaVersion:number, authority:string, materialSourceRegistrySnapshot:Object, spoolMountRepositorySnapshot:Object, committedTransactionsById:Object, committedOperationsById:Object, lifecycleBySubject:Object, events:Array<Object>, retainedUnsupportedEntries:Array<Object>, invariants:Object}}
   */
  materialAccountingMigrationShadowStore: {
    schemaVersion: 1,
    authority: "migration-shadow-commit-store",
    materialSourceRegistrySnapshot: { sources: [], conflicts: [] },
    spoolMountRepositorySnapshot: { mounts: [], conflicts: [] },
    committedTransactionsById: {},
    committedOperationsById: {},
    lifecycleBySubject: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      ledgerWrites: false,
      legacyCutoverSealed: false,
      materialSourceRepositoryWrites: "shadow-only",
      spoolMountRepositoryWrites: "shadow-only",
    },
  },
  /**
   * Gate 18.9E: MaterialSource print binding shadow store。
   * print-start時点のMaterialSource/SpoolMount snapshotとsource-specific usage attributionを
   * 保持する。これはまだlegacy usageHistoryやspool残量を更新するauthorityではない。
   * @type {{schemaVersion:number, authority:string, printStartSnapshots:Array<Object>, usageEvidence:Array<Object>, jobMaterialSegments:Array<Object>, ledgerEvents:Array<Object>, unattributedUsage:Array<Object>, operationsById:Object, invariants:Object}}
   */
  materialAccountingPrintBindingStore: {
    schemaVersion: 1,
    authority: "material-accounting-print-binding-shadow-store",
    printStartSnapshots: [],
    usageEvidence: [],
    jobMaterialSegments: [],
    ledgerEvents: [],
    unattributedUsage: [],
    operationsById: {},
    invariants: {
      legacyUsageHistoryWrites: false,
      legacySpoolRemainingWrites: false,
      materialSourceLedgerWrites: "shadow-only",
    },
  },
  /**
   * Gate 18.9H: operator-managed MaterialSource SpoolMount production store。
   * CFS/CFS-C/外部スプールを含む任意のMaterialSourceへ、3DPmon管理スプールを
   * operator確認付きでmount/unmount/replaceするための権威storeである。
   * ここへ保存してもlegacy hostSpoolMap、usageHistory、スプール残量、print bindingへは
   * 自動投影しない。production操作の成功判定はIndexedDB CAS成功時だけ行う。
   * @type {{schemaVersion:number, authority:string, storeRevision:number, storeDigest:string, spoolMounts:Array<Object>, events:Array<Object>, conflicts:Array<Object>, retainedUnsupportedEntries:Array<Object>, invariants:Object}}
   */
  materialAccountingSpoolMountStore: createEmptyMaterialAccountingSpoolMountStore(),
   /**
   * Gate 19 prep: 物理コマンド復旧ラッチ。
   * CFS select/load/unloadなど物理状態を変えるコマンドがsubmitted/post-observed/unknownで終わった場合に、
   * 再起動後も「確認が必要な未解決証跡」として保持する。command frameやRPC payloadは保存せず、
   * 自動再送も絶対に行わない。
   * @type {{schemaVersion:number, authority:string, unresolvedByCommandId:Object.<string, Object>, conflictedCommandIds:Array<string>, events:Array<Object>, retainedUnsupportedEntries:Array<Object>, invariants:Object}}
   */
  physicalCommandRecoveryLatch: {
    schemaVersion: 1,
    authority: "physical-command-recovery-latch",
    unresolvedByCommandId: {},
    conflictedCommandIds: [],
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      autoReplay: false,
      commandFramePersistence: false,
      physicalCommandAuthority: "recovery-latch-only",
    },
  },
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
 * 指定ホストの「表示名（呼び出し名称）」を解決する。
 *
 * 優先順: 接続先設定の表示名(label) ＞ 機器申告ホスト名 ＞ モデル名 ＞ ホストキー。
 * ユーザーに見せる名称（通知の {hostname} 置換・読み上げ・機器別設定一覧・トップバー等）は
 * 全てこれを通すことで、ユーザーが付けた表示名を「呼び出し名称」として一貫適用する。
 *
 * 接続先設定は host（＝機器申告ホスト名 or IP キー）から hostname / dest / dest先頭IP の
 * いずれかで逆引きする。これにより Moonraker のようにホストキーが IP のまま
 * （ホスト名へ未移行）でも label を解決できる。monitorData のみ参照（循環回避のため
 * connection.js には依存しない）。
 *
 * @function getHostDisplayName
 * @param {string} host - ホストキー（機器申告ホスト名 or IP）
 * @returns {string} 表示名
 */
export function getHostDisplayName(host) {
  if (!host) return host || "";
  const targets = monitorData.appSettings?.connectionTargets || [];
  const tgt = targets.find(t => t && (
    t.hostname === host ||
    t.dest === host ||
    (typeof t.dest === "string" && t.dest.startsWith(host + ":"))
  ));
  const label = (tgt?.label || "").trim();
  if (label) return label;
  const m = monitorData.machines?.[host];
  return m?.storedData?.hostname?.rawValue || m?.storedData?.model?.rawValue || host;
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
