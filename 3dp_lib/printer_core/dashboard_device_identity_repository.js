/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 identity repository モジュール
 * @file dashboard_device_identity_repository.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_device_identity_repository
 *
 * 【機能内容サマリ】
 * - connectionTargets 上に同居する Printer Core v3 identity dry-run レコードを管理
 * - 既存接続層から保存先の詳細を分離し、Data Schema v3 repository へ移行しやすくする
 * - serial / stable machine id を強い識別材料、MAC を endpoint alias として扱う
 *
 * 【公開関数一覧】
 * - {@link mergePrinterCoreV3IdentityRecords}：identity dry-run レコードを統合
 * - {@link transferPrinterCoreV3IdentityRecords}：旧 target の identity 情報を新 target へ移す
 * - {@link recordPrinterCoreV3Identity}：観測 evidence を target へ保存
 * - {@link toComparablePrinterCoreV3Identity}：時刻差分を除いた比較用コピーを生成
 *
 * @version 1.390.1337 (PR #432)
 * @since   1.390.1292 (PR #432)
 * @lastModified 2026-08-09 01:40:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 3 以降で Data Schema v3 の `devices` / `deviceEndpoints` store へ保存先を差し替える
 */

"use strict";

import {
  createDeviceIdentityCandidate,
  mergeDeviceIdentityCandidate,
  shouldMergeDeviceIdentity,
} from "./dashboard_device_identity.js";

/**
 * connectionTargets に保存する Printer Core v3 identity dry-run の schema version。
 *
 * 【詳細説明】
 * - Gate 2 時点では connectionTargets 上の同居データであり、まだ v3 store の権威データではない。
 * - 後続 migration で同居データと正式 store データを区別するため、保存時に明示する。
 *
 * @constant {number}
 */
export const PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION = 1;

/**
 * Printer Core v3 identity dry-run の比較用コピーを返す。
 *
 * 【詳細説明】
 * - `lastObservedAt` / `observedAt` は観測時刻であり、内容が同じ受信でも毎回変化する。
 * - `lastEvidenceReason` / `lastMergeDecision` / `evidenceReasons` は監査用メタ情報であり、
 *   deviceId seed や endpoint alias が変わらない再観測では保存理由にしない。
 * - 保存頻度を抑え、テスト比較を安定させるため、動的・監査系フィールドを除いたコピーを返す。
 *
 * @function toComparablePrinterCoreV3Identity
 * @param {object|null|undefined} record - v3 identity dry-run 候補
 * @returns {object|null} 比較用に動的時刻を除いた候補
 * @example
 * const comparable = toComparablePrinterCoreV3Identity(target.printerCoreV3Identity);
 */
export function toComparablePrinterCoreV3Identity(record) {
  if (!record) return null;
  const comparable = { ...record };
  delete comparable.lastObservedAt;
  delete comparable.observedAt;
  delete comparable.detectedAt;
  delete comparable.resolvedAt;
  delete comparable.lastEvidenceReason;
  delete comparable.lastMergeDecision;
  delete comparable.evidenceReasons;
  return comparable;
}

/**
 * Printer Core v3 identity evidence 配列を比較用コピーへ変換する。
 *
 * 【詳細説明】
 * - 複数 conflict / pending を保持する配列でも、検出時刻や監査メタデータだけの差分で
 *   changed にならないようにする。
 *
 * @private
 * @param {Array<object>|null|undefined} records - identity evidence 配列
 * @returns {Array<object>} 比較用 evidence 配列
 */
function toComparablePrinterCoreV3IdentityList(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => toComparablePrinterCoreV3Identity(record))
    .filter(Boolean);
}

/**
 * connectionTarget 上の identity repository 状態を比較用にまとめる。
 *
 * 【詳細説明】
 * - singleton と plural の両方を比較に含め、後方互換フィールドだけ更新された場合も検出する。
 *
 * @private
 * @param {object} target - connectionTarget
 * @returns {object} 比較用 repository 状態
 */
function toComparablePrinterCoreV3RepositoryState(target) {
  return {
    identity: toComparablePrinterCoreV3Identity(target?.printerCoreV3Identity),
    conflict: toComparablePrinterCoreV3Identity(target?.printerCoreV3IdentityConflict),
    pending: toComparablePrinterCoreV3Identity(target?.printerCoreV3PendingIdentityCandidate),
    conflicts: toComparablePrinterCoreV3IdentityList(target?.printerCoreV3IdentityConflicts),
    pendings: toComparablePrinterCoreV3IdentityList(target?.printerCoreV3PendingIdentityCandidates),
  };
}

/**
 * identity evidence を重複なく配列へ追加する。
 *
 * 【詳細説明】
 * - `printerCoreV3IdentityConflict` などの singleton は古いコード向けの互換フィールドとして残す。
 * - `printerCoreV3IdentityConflicts` などの plural 配列は、Data Schema v3 移行時に複数証拠を
 *   失わないための dry-run evidence log として扱う。
 *
 * @private
 * @param {object} target - connectionTarget
 * @param {string} listKey - plural evidence 配列のプロパティ名
 * @param {string} singletonKey - 後方互換 singleton プロパティ名
 * @param {object|null|undefined} record - 追加する evidence
 * @param {object=} options - 追加オプション
 * @param {boolean=} options.updateSingleton - singleton もこの record で更新する場合 true
 * @returns {boolean} 配列または singleton が変化した場合 true
 */
function appendPrinterCoreV3EvidenceRecord(target, listKey, singletonKey, record, options = {}) {
  if (!target || !record) return false;
  const updateSingleton = options.updateSingleton !== false;
  const currentList = Array.isArray(target[listKey]) ? [...target[listKey]] : [];
  const comparableRecord = JSON.stringify(toComparablePrinterCoreV3Identity(record));
  const comparableSingleton = JSON.stringify(toComparablePrinterCoreV3Identity(target[singletonKey]));
  const singletonChanged = (updateSingleton || !target[singletonKey]) &&
    comparableSingleton !== comparableRecord;
  const exists = currentList.some((entry) => {
    return JSON.stringify(toComparablePrinterCoreV3Identity(entry)) === comparableRecord;
  });
  if (!exists) {
    currentList.push(record);
    target[listKey] = currentList;
  } else if (!Array.isArray(target[listKey])) {
    target[listKey] = currentList;
  }
  if (updateSingleton || !target[singletonKey]) {
    target[singletonKey] = record;
  }
  return !exists || singletonChanged;
}

/**
 * source target の identity evidence を target へ重複なく移送する。
 *
 * 【詳細説明】
 * - source 側に plural 配列があれば全件をコピーし、旧形式の singleton しかない場合も取り込む。
 * - target 側に singleton が既にある場合は、互換 singleton を上書きせず plural 配列へだけ追加する。
 *
 * @private
 * @param {object} target - 統合先 connectionTarget
 * @param {object} sourceTarget - 統合元 connectionTarget
 * @param {string} listKey - plural evidence 配列のプロパティ名
 * @param {string} singletonKey - 後方互換 singleton プロパティ名
 * @returns {void}
 */
function transferPrinterCoreV3EvidenceRecords(target, sourceTarget, listKey, singletonKey) {
  const sourceRecords = Array.isArray(sourceTarget?.[listKey]) ? sourceTarget[listKey] : [];
  for (const record of sourceRecords) {
    appendPrinterCoreV3EvidenceRecord(target, listKey, singletonKey, record, {
      updateSingleton: !target[singletonKey],
    });
  }
  if (sourceTarget?.[singletonKey]) {
    appendPrinterCoreV3EvidenceRecord(target, listKey, singletonKey, sourceTarget[singletonKey], {
      updateSingleton: !target[singletonKey],
    });
  }
}

/**
 * connectionTargets 上の Printer Core v3 identity dry-run 候補を統合する。
 *
 * 【詳細説明】
 * - hostname 由来の DHCP 統合では、旧 endpoint に保存されていた v3 identity 候補も新 endpoint へ
 *   引き継ぐ必要がある。
 * - serial / stableMachineId が矛盾する場合は統合せず、既存値を保護する。
 * - MAC 一致や同一 target 上の追加観測は dry-run の補助証跡として統合するが、この値は
 *   まだ接続可否や UI 挙動の権威にはしない。
 *
 * @function mergePrinterCoreV3IdentityRecords
 * @param {object|null|undefined} existing - 既存の v3 identity dry-run 候補
 * @param {object|null|undefined} incoming - 追加する v3 identity dry-run 候補
 * @returns {object|null} 統合後の v3 identity dry-run 候補
 * @example
 * const merged = mergePrinterCoreV3IdentityRecords(current, observed);
 */
export function mergePrinterCoreV3IdentityRecords(existing, incoming) {
  if (!existing && !incoming) return null;
  if (!existing) return incoming;
  if (!incoming) return existing;

  const decision = shouldMergeDeviceIdentity(existing, incoming);
  if (!decision.merge || decision.confidence === "conflict") {
    return {
      ...existing,
      schemaVersion: PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
      dryRun: true,
      lastMergeDecision: decision,
    };
  }

  return {
    ...mergeDeviceIdentityCandidate(existing, incoming),
    schemaVersion: PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
    dryRun: true,
    lastMergeDecision: decision,
  };
}

/**
 * 旧 connectionTarget の Printer Core v3 identity dry-run 情報を新 target へ移す。
 *
 * 【詳細説明】
 * - DHCP 統合や endpoint 移行で connectionTargets の実体を一つに寄せる際に使う。
 * - identity は record 時と同じ判定で、strong match のみ統合し、conflict / unknown / weak は
 *   source 側の証拠を失わないよう conflict または pending に退避する。
 * - 既存 conflict は新 target 側に未記録の場合のみ引き継ぐ。
 * - 戻り値の `changed` は呼び出し側が保存を行うかどうかを判断するために使う。
 *
 * @function transferPrinterCoreV3IdentityRecords
 * @param {object} target - 統合先 connectionTarget
 * @param {object} sourceTarget - 統合元 connectionTarget
 * @returns {{changed:boolean, identity:(object|null), conflict:(object|null), pending:(object|null)}} 統合結果
 * @example
 * const result = transferPrinterCoreV3IdentityRecords(currentTarget, staleTarget);
 */
export function transferPrinterCoreV3IdentityRecords(target, sourceTarget) {
  if (!target || !sourceTarget) {
    return {
      changed: false,
      identity: target?.printerCoreV3Identity || null,
      conflict: target?.printerCoreV3IdentityConflict || null,
      pending: target?.printerCoreV3PendingIdentityCandidate || null,
    };
  }
  const before = JSON.stringify(toComparablePrinterCoreV3RepositoryState(target));

  if (sourceTarget.printerCoreV3Identity && !target.printerCoreV3Identity) {
    target.printerCoreV3Identity = sourceTarget.printerCoreV3Identity;
  } else if (sourceTarget.printerCoreV3Identity) {
    const decision = shouldMergeDeviceIdentity(
      target.printerCoreV3Identity,
      sourceTarget.printerCoreV3Identity
    );
    if (decision.confidence === "conflict") {
      appendPrinterCoreV3EvidenceRecord(
        target,
        "printerCoreV3IdentityConflicts",
        "printerCoreV3IdentityConflict",
        createOpenIdentityConflict(
          target.printerCoreV3Identity,
          sourceTarget.printerCoreV3Identity,
          decision
        )
      );
    } else if (!decision.merge || decision.confidence === "weak") {
      appendPrinterCoreV3EvidenceRecord(
        target,
        "printerCoreV3PendingIdentityCandidates",
        "printerCoreV3PendingIdentityCandidate",
        createPendingIdentityCandidate(
          sourceTarget.printerCoreV3Identity,
          decision
        )
      );
    } else {
      target.printerCoreV3Identity = mergePrinterCoreV3IdentityRecords(
        target.printerCoreV3Identity,
        sourceTarget.printerCoreV3Identity
      );
    }
  }
  transferPrinterCoreV3EvidenceRecords(
    target,
    sourceTarget,
    "printerCoreV3IdentityConflicts",
    "printerCoreV3IdentityConflict"
  );
  transferPrinterCoreV3EvidenceRecords(
    target,
    sourceTarget,
    "printerCoreV3PendingIdentityCandidates",
    "printerCoreV3PendingIdentityCandidate"
  );

  const after = JSON.stringify(toComparablePrinterCoreV3RepositoryState(target));
  return {
    changed: before !== after,
    identity: target.printerCoreV3Identity || null,
    conflict: target.printerCoreV3IdentityConflict || null,
    pending: target.printerCoreV3PendingIdentityCandidate || null,
    conflicts: target.printerCoreV3IdentityConflicts || [],
    pendings: target.printerCoreV3PendingIdentityCandidates || [],
  };
}

/**
 * 観測 evidence から Printer Core v3 identity candidate を生成する。
 *
 * 【詳細説明】
 * - target 自身と今回 evidence に含まれる MAC alias だけを候補にし、既存 identity の alias は
 *   merge 判定後の統合処理で引き継ぐ。
 * - endpointAddress は呼び出し側が接続先正規化済みの値を渡す。
 *
 * @private
 * @param {object} target - connectionTarget
 * @param {object} evidence - WebSocket 受信データまたは ARP 解決結果
 * @param {object} options - candidate 生成オプション
 * @param {string=} options.hostOrDest - 呼び出し元が扱っている host/dest
 * @param {string=} options.endpointAddress - 正規化済み endpoint address
 * @returns {object} identity candidate
 */
function createPrinterCoreV3IdentityCandidate(target, evidence, options) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const observedSource = source.source ?? source.observedVia ?? source.protocolSource;
  const reportedHostname = source.reportedHostname || source.hostname ||
    (observedSource === "http-info" ? null : target.hostname || options.hostOrDest);
  const macAliases = [
    target.macAddress,
    ...(Array.isArray(source.macAliases) ? source.macAliases : []),
  ];

  return createDeviceIdentityCandidate({
    source: observedSource,
    serialNumber: source.serialNumber || source.sn || source.serial,
    stableMachineId: source.stableMachineId || source.machineId,
    reportedModel: source.reportedModel || source.model || source.printerModel,
    reportedHostname,
    firmwareVersion: source.firmwareVersion ?? source.version,
    wssPort: source.wssPort,
    videoPort: source.videoPort,
    endpointAddress: source.endpointAddress || options.endpointAddress,
    macAddress: source.macAddress || source.mac || target.macAddress,
    macAliases,
  });
}

/**
 * merge 不可または weak 判定の候補を pending レコードへ整形する。
 *
 * 【詳細説明】
 * - serial / stableMachineId などの権威候補を持つ既存 identity へ、共有証跡のない候補を混ぜない。
 * - MAC overlap だけの weak 判定も pending に留め、後続の serial 観測で安全に確定できるようにする。
 *
 * @private
 * @param {object} candidate - 保留する identity candidate
 * @param {object} decision - shouldMergeDeviceIdentity の判定結果
 * @returns {object} pending レコード
 */
function createPendingIdentityCandidate(candidate, decision) {
  return {
    schemaVersion: PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
    dryRun: true,
    status: "pending",
    decision,
    candidate,
    observedAt: new Date().toISOString(),
  };
}

/**
 * identity conflict を open 状態の監査レコードへ整形する。
 *
 * 【詳細説明】
 * - 既存 identity と衝突した候補の両方を保存し、次の正常フレームで情報が消えないようにする。
 * - 解決は明示オプションで行うため、通常観測では status=open のまま保持する。
 *
 * @private
 * @param {object|null} existingIdentity - 既存 identity
 * @param {object} candidate - 衝突した identity candidate
 * @param {object} decision - shouldMergeDeviceIdentity の判定結果
 * @returns {object} conflict レコード
 */
function createOpenIdentityConflict(existingIdentity, candidate, decision) {
  return {
    schemaVersion: PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
    dryRun: true,
    status: "open",
    decision,
    existingIdentity,
    conflictingCandidate: candidate,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * open conflict を resolved 状態へ更新する。
 *
 * 【詳細説明】
 * - Gate 2 の dry-run では自動削除せず、監査証跡として解決時刻と理由を残す。
 * - 呼び出し側が `allowConflictResolution` を指定した時だけ利用する。
 *
 * @private
 * @param {object} conflict - 既存 conflict
 * @param {object} decision - 解決根拠の merge 判定
 * @returns {object} resolved conflict
 */
function createResolvedIdentityConflict(conflict, decision) {
  return {
    ...conflict,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
    resolutionReason: decision.reason,
  };
}

/**
 * singleton と plural の conflict record を同時に resolved へ更新する。
 *
 * 【詳細説明】
 * - `printerCoreV3IdentityConflict` は旧コード互換の singleton だが、live shadow の安全判定は
 *   `printerCoreV3IdentityConflicts[]` も参照する。
 * - singleton だけを resolved にすると plural 側の open が残り、実際には解決済みの target が
 *   いつまでも provisional shadow ID 扱いになるため、同一 record を両方で更新する。
 *
 * @private
 * @param {object} target - connectionTarget
 * @param {object} decision - 解決根拠の merge 判定
 * @returns {boolean} conflict record を更新した場合 true
 */
function resolvePrinterCoreV3ConflictRecords(target, decision) {
  if (!target?.printerCoreV3IdentityConflict) {
    return false;
  }
  const openConflict = target.printerCoreV3IdentityConflict;
  const comparableOpenConflict = JSON.stringify(toComparablePrinterCoreV3Identity(openConflict));
  const resolvedConflict = createResolvedIdentityConflict(openConflict, decision);
  target.printerCoreV3IdentityConflict = resolvedConflict;

  const currentList = Array.isArray(target.printerCoreV3IdentityConflicts)
    ? target.printerCoreV3IdentityConflicts
    : [openConflict];
  target.printerCoreV3IdentityConflicts = currentList.map((entry) => {
    const comparableEntry = JSON.stringify(toComparablePrinterCoreV3Identity(entry));
    if (entry?.status === "open" && comparableEntry === comparableOpenConflict) {
      return createResolvedIdentityConflict(entry, decision);
    }
    return entry;
  });
  return true;
}

/**
 * 観測 evidence を connectionTarget へ Printer Core v3 identity dry-run として保存する。
 *
 * 【詳細説明】
 * - Gate 2 では保存先は `connectionTargets[].printerCoreV3Identity` のままだが、保存判断と
 *   conflict 処理はこの repository に閉じ込める。
 * - Moonraker target は Creality Printer Core v3 identity の対象外なのでスキップする。
 * - serial 矛盾など強い conflict は `printerCoreV3IdentityConflict` に残し、既存値を上書きしない。
 *
 * @function recordPrinterCoreV3Identity
 * @param {object|null|undefined} target - 保存対象 connectionTarget
 * @param {object} evidence - WebSocket 受信データまたは ARP 解決結果
 * @param {object=} options - 保存オプション
 * @param {string=} options.hostOrDest - 接続キー、hostname、または dest
 * @param {string=} options.endpointAddress - 接続元 endpoint の IP / host
 * @param {boolean=} options.allowConflictResolution - open conflict を resolved に更新してよい場合に true
 * @param {boolean=} options.allowWeakMerge - MAC overlap だけの weak 判定を統合してよい場合に true
 * @returns {{changed:boolean, identity:(object|null), conflict:(object|null), pending:(object|null), decision:object|null}} 保存結果
 * @example
 * const result = recordPrinterCoreV3Identity(target, data, { endpointAddress: "printer.local" });
 */
export function recordPrinterCoreV3Identity(target, evidence, options = {}) {
  if (!target || target.printerType === "moonraker") {
    return { changed: false, identity: null, conflict: null, pending: null, decision: null };
  }

  const candidate = createPrinterCoreV3IdentityCandidate(target, evidence, options);
  const existing = target.printerCoreV3Identity || null;
  const decision = existing ? shouldMergeDeviceIdentity(existing, candidate) : {
    merge: true,
    confidence: "new",
    reason: "first-observation",
  };

  if (decision.confidence === "conflict") {
    const before = JSON.stringify(toComparablePrinterCoreV3RepositoryState(target));
    const nextConflict = createOpenIdentityConflict(existing, candidate, decision);
    appendPrinterCoreV3EvidenceRecord(
      target,
      "printerCoreV3IdentityConflicts",
      "printerCoreV3IdentityConflict",
      nextConflict
    );
    if (before === JSON.stringify(toComparablePrinterCoreV3RepositoryState(target))) {
      return {
        changed: false,
        identity: target.printerCoreV3Identity || null,
        conflict: target.printerCoreV3IdentityConflict || null,
        pending: target.printerCoreV3PendingIdentityCandidate || null,
        decision,
      };
    }
    return {
      changed: true,
      identity: target.printerCoreV3Identity || null,
      conflict: target.printerCoreV3IdentityConflict,
      pending: target.printerCoreV3PendingIdentityCandidate || null,
      decision,
    };
  }

  if (!decision.merge || (decision.confidence === "weak" && !options.allowWeakMerge)) {
    const before = JSON.stringify(toComparablePrinterCoreV3RepositoryState(target));
    const nextPending = createPendingIdentityCandidate(candidate, decision);
    appendPrinterCoreV3EvidenceRecord(
      target,
      "printerCoreV3PendingIdentityCandidates",
      "printerCoreV3PendingIdentityCandidate",
      nextPending
    );
    if (before === JSON.stringify(toComparablePrinterCoreV3RepositoryState(target))) {
      return {
        changed: false,
        identity: target.printerCoreV3Identity || null,
        conflict: target.printerCoreV3IdentityConflict || null,
        pending: target.printerCoreV3PendingIdentityCandidate || null,
        decision,
      };
    }
    return {
      changed: true,
      identity: target.printerCoreV3Identity || null,
      conflict: target.printerCoreV3IdentityConflict || null,
      pending: target.printerCoreV3PendingIdentityCandidate,
      decision,
    };
  }

  const nextIdentity = {
    ...mergePrinterCoreV3IdentityRecords(existing, candidate),
    schemaVersion: PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
    dryRun: true,
    lastObservedAt: new Date().toISOString(),
    lastEvidenceReason: decision.reason,
  };
  const canResolveConflict = Boolean(
    target.printerCoreV3IdentityConflict &&
    options.allowConflictResolution === true &&
    decision.merge === true &&
    decision.confidence === "strong"
  );
  if (JSON.stringify(toComparablePrinterCoreV3Identity(existing)) ===
      JSON.stringify(toComparablePrinterCoreV3Identity(nextIdentity)) &&
      !canResolveConflict) {
    return {
      changed: false,
      identity: target.printerCoreV3Identity,
      conflict: target.printerCoreV3IdentityConflict || null,
      pending: target.printerCoreV3PendingIdentityCandidate || null,
      decision,
    };
  }

  target.printerCoreV3Identity = nextIdentity;
  if (canResolveConflict) {
    resolvePrinterCoreV3ConflictRecords(target, decision);
  }
  return {
    changed: true,
    identity: target.printerCoreV3Identity,
    conflict: target.printerCoreV3IdentityConflict || null,
    pending: target.printerCoreV3PendingIdentityCandidate || null,
    decision,
  };
}
