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
 * @version 1.390.1292 (PR #432)
 * @since   1.390.1292 (PR #432)
 * @lastModified 2026-08-07 01:22:00
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
  delete comparable.lastEvidenceReason;
  delete comparable.lastMergeDecision;
  delete comparable.evidenceReasons;
  return comparable;
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
  if (decision.confidence === "conflict") {
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
 * - identity は統合し、conflict は新 target 側に未記録の場合のみ引き継ぐ。
 * - 戻り値の `changed` は呼び出し側が保存を行うかどうかを判断するために使う。
 *
 * @function transferPrinterCoreV3IdentityRecords
 * @param {object} target - 統合先 connectionTarget
 * @param {object} sourceTarget - 統合元 connectionTarget
 * @returns {{changed:boolean, identity:(object|null)}} 統合結果
 * @example
 * const result = transferPrinterCoreV3IdentityRecords(currentTarget, staleTarget);
 */
export function transferPrinterCoreV3IdentityRecords(target, sourceTarget) {
  if (!target || !sourceTarget) {
    return { changed: false, identity: target?.printerCoreV3Identity || null };
  }
  const before = JSON.stringify({
    identity: toComparablePrinterCoreV3Identity(target.printerCoreV3Identity),
    conflict: toComparablePrinterCoreV3Identity(target.printerCoreV3IdentityConflict),
  });

  if (sourceTarget.printerCoreV3Identity) {
    target.printerCoreV3Identity = mergePrinterCoreV3IdentityRecords(
      target.printerCoreV3Identity,
      sourceTarget.printerCoreV3Identity
    );
  }
  if (sourceTarget.printerCoreV3IdentityConflict && !target.printerCoreV3IdentityConflict) {
    target.printerCoreV3IdentityConflict = sourceTarget.printerCoreV3IdentityConflict;
  }

  const after = JSON.stringify({
    identity: toComparablePrinterCoreV3Identity(target.printerCoreV3Identity),
    conflict: toComparablePrinterCoreV3Identity(target.printerCoreV3IdentityConflict),
  });
  return {
    changed: before !== after,
    identity: target.printerCoreV3Identity || null,
  };
}

/**
 * 観測 evidence から Printer Core v3 identity candidate を生成する。
 *
 * 【詳細説明】
 * - target に既に保存済みの MAC alias も候補に含め、複数 NIC の観測を落とさない。
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
  const macAliases = [
    target.macAddress,
    ...(Array.isArray(source.macAliases) ? source.macAliases : []),
    ...(target.printerCoreV3Identity?.endpointAliases?.macs || []),
  ];

  return createDeviceIdentityCandidate({
    serialNumber: source.serialNumber || source.sn || source.serial,
    stableMachineId: source.stableMachineId || source.machineId,
    reportedModel: source.reportedModel || source.model || source.printerModel,
    reportedHostname: source.reportedHostname || source.hostname || target.hostname || options.hostOrDest,
    endpointAddress: source.endpointAddress || options.endpointAddress,
    macAddress: source.macAddress || source.mac || target.macAddress,
    macAliases,
  });
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
 * @returns {{changed:boolean, identity:(object|null), conflict:(object|null), decision:object|null}} 保存結果
 * @example
 * const result = recordPrinterCoreV3Identity(target, data, { endpointAddress: "printer.local" });
 */
export function recordPrinterCoreV3Identity(target, evidence, options = {}) {
  if (!target || target.printerType === "moonraker") {
    return { changed: false, identity: null, conflict: null, decision: null };
  }

  const candidate = createPrinterCoreV3IdentityCandidate(target, evidence, options);
  const existing = target.printerCoreV3Identity || null;
  const decision = existing ? shouldMergeDeviceIdentity(existing, candidate) : {
    merge: true,
    confidence: "new",
    reason: "first-observation",
  };

  if (decision.confidence === "conflict") {
    const nextConflict = {
      schemaVersion: PRINTER_CORE_V3_IDENTITY_SCHEMA_VERSION,
      dryRun: true,
      decision,
      candidate,
      observedAt: new Date().toISOString(),
    };
    if (JSON.stringify(toComparablePrinterCoreV3Identity(target.printerCoreV3IdentityConflict)) ===
        JSON.stringify(toComparablePrinterCoreV3Identity(nextConflict))) {
      return {
        changed: false,
        identity: target.printerCoreV3Identity || null,
        conflict: target.printerCoreV3IdentityConflict || null,
        decision,
      };
    }
    target.printerCoreV3IdentityConflict = nextConflict;
    return {
      changed: true,
      identity: target.printerCoreV3Identity || null,
      conflict: target.printerCoreV3IdentityConflict,
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
  if (JSON.stringify(toComparablePrinterCoreV3Identity(existing)) ===
      JSON.stringify(toComparablePrinterCoreV3Identity(nextIdentity)) &&
      !target.printerCoreV3IdentityConflict) {
    return {
      changed: false,
      identity: target.printerCoreV3Identity,
      conflict: null,
      decision,
    };
  }

  target.printerCoreV3Identity = nextIdentity;
  delete target.printerCoreV3IdentityConflict;
  return {
    changed: true,
    identity: target.printerCoreV3Identity,
    conflict: null,
    decision,
  };
}
