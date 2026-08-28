/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 material provider モジュール
 * @file dashboard_material_provider.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_provider
 *
 * 【機能内容サマリ】
 * - K2 CFS `boxsInfo` を read-only material topology として提供
 * - K1C/CFS-C の Moonraker 由来 CFS payload を同じ topology contract へ正規化
 * - material 観測と filament ledger authority の境界を明示
 * - CFS 未接続時にも同一 shape の material topology を返す
 *
 * 【公開関数一覧】
 * - {@link createNoCfsMaterialProvider}：CFS 非対応/未観測用 material provider を生成
 * - {@link createCfsBoxsInfoMaterialProvider}：K2 `boxsInfo` 用 read-only material provider を生成
 * - {@link createCfsMoonrakerBoxMaterialProvider}：K1C/CFS-C `boxsInfo` 用 read-only material provider を生成
 *
 * @version 1.390.1457 (PR #435)
 * @since   1.390.1312 (PR #432)
 * @lastModified 2026-08-28 16:58:45
 * -----------------------------------------------------------
 * @todo
 * - Data Schema v3 の MaterialSource store と接続する際に provider event 化する
 */

"use strict";

import { normalizeK2BoxsInfo } from "./dashboard_normalized_state.js";

/**
 * Printer Core v3 material provider の schema version。
 *
 * 【詳細説明】
 * - provider 自体の契約 version であり、material topology の schemaVersion とは分けて管理する。
 *
 * @constant {number}
 */
export const MATERIAL_PROVIDER_SCHEMA_VERSION = 1;

/**
 * topology へ provider metadata を付与する。
 *
 * 【詳細説明】
 * - NormalizedState 側の `authority.canDriveLedger=false` を provider 境界でも再確認し、
 *   呼び出し側が CFS 観測を filament ledger の確定入力として誤用しないようにする。
 *
 * @private
 * @param {object} topology - 正規化済み material topology
 * @param {object} provider - provider metadata
 * @returns {object} provider metadata 付き material topology
 */
function attachMaterialProviderMetadata(topology, provider) {
  const sourceTopology = topology && typeof topology === "object" ? topology : normalizeK2BoxsInfo(null);
  return {
    ...sourceTopology,
    authority: {
      ...(sourceTopology.authority || {}),
      mode: "read-only-observation",
      canDriveLedger: false,
      providerId: provider.providerId,
    },
    provider: {
      schemaVersion: MATERIAL_PROVIDER_SCHEMA_VERSION,
      providerId: provider.providerId,
      readOnly: true,
      supportsCfs: Boolean(provider.supportsCfs),
      canDriveLedger: false,
      transportKind: provider.transportKind || "unknown",
      sourceProtocol: provider.sourceProtocol || "unknown",
    },
  };
}

/**
 * CFS 非対応/未観測用 material provider を生成する。
 *
 * 【詳細説明】
 * - K1 や CFS 未観測状態でも同じ provider contract を返し、MaterialProvider 不在を特別扱いしない。
 *
 * @function createNoCfsMaterialProvider
 * @returns {object} read-only material provider
 * @example
 * const provider = createNoCfsMaterialProvider();
 */
export function createNoCfsMaterialProvider() {
  const provider = {
    schemaVersion: MATERIAL_PROVIDER_SCHEMA_VERSION,
    providerId: "material:none",
    readOnly: true,
    supportsCfs: false,
    canDriveLedger: false,
    transportKind: "none",
    sourceProtocol: "none",
    /**
     * 空の material topology を返す。
     *
     * 【詳細説明】
     * - CFS が無い/未観測の状態を `unobserved` として表し、台帳 authority にはしない。
     *
     * @function createTopology
     * @returns {object} 空の material topology
     */
    createTopology() {
      return attachMaterialProviderMetadata(normalizeK2BoxsInfo(null), provider);
    },
  };
  return provider;
}

/**
 * K2 `boxsInfo` 用 read-only material provider を生成する。
 *
 * 【詳細説明】
 * - CFS topology は UI/診断向けの観測値として扱い、filament ledger の確定消費や mount authority にはしない。
 * - `normalizeBoxsInfo` はテストで差し替え可能にし、provider 境界だけを検証できるようにする。
 *
 * @function createCfsBoxsInfoMaterialProvider
 * @param {object=} options - provider 生成オプション
 * @param {Function=} options.normalizeBoxsInfo - `boxsInfo` を topology へ変換する関数
 * @returns {object} K2 CFS read-only material provider
 * @example
 * const provider = createCfsBoxsInfoMaterialProvider();
 */
export function createCfsBoxsInfoMaterialProvider(options = {}) {
  const normalizeBoxsInfo = typeof options.normalizeBoxsInfo === "function"
    ? options.normalizeBoxsInfo
    : normalizeK2BoxsInfo;
  const provider = {
    schemaVersion: MATERIAL_PROVIDER_SCHEMA_VERSION,
    providerId: "creality-cfs-boxs-info",
    readOnly: true,
    supportsCfs: true,
    canDriveLedger: false,
    transportKind: "ws9999",
    sourceProtocol: "creality-boxsInfo",
    /**
     * `boxsInfo` payload を read-only material topology へ変換する。
     *
     * 【詳細説明】
     * - connected などの接続状態は status frame 由来の protocolState から渡される。
     * - 戻り値には provider metadata を付け、後続処理が権限境界を確認できるようにする。
     *
     * @function createTopology
     * @param {object|null|undefined} boxsInfo - K2 `boxsInfo` payload
     * @param {object=} topologyOptions - topology 正規化オプション
     * @returns {object} provider metadata 付き material topology
     */
    createTopology(boxsInfo, topologyOptions = {}) {
      return attachMaterialProviderMetadata(normalizeBoxsInfo(boxsInfo, topologyOptions), provider);
    },
  };
  return provider;
}

/**
 * Moonraker/CFS-C 由来 payload から `boxsInfo` 相当の object を抽出する。
 *
 * 【詳細説明】
 * - K1C+CFS-C 実機は別ネットワークで検証するため、Gate 12 準備では複数の read-only envelope を受けられる
 *   入口だけを用意する。
 * - `boxsInfo` そのもの、`result.boxsInfo`、`result.boxs_info`、`params.boxsInfo`、`data.boxsInfo` を順に見る。
 * - どの形にも一致しない payload はそのまま返し、後段の normalizer が空/不正 topology として扱えるようにする。
 *
 * @function extractMoonrakerBoxsInfoPayload
 * @param {object|null|undefined} payload - Moonraker/CFS-C 由来の read-only payload
 * @returns {object|null|undefined} `boxsInfo` 相当 payload、または入力 payload
 * @example
 * const boxsInfo = extractMoonrakerBoxsInfoPayload({ result: { boxsInfo: {} } });
 */
export function extractMoonrakerBoxsInfoPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  if (payload.boxsInfo && typeof payload.boxsInfo === "object") {
    return payload.boxsInfo;
  }
  if (payload.boxs_info && typeof payload.boxs_info === "object") {
    return payload.boxs_info;
  }
  for (const envelopeKey of ["result", "params", "data"]) {
    const envelope = payload[envelopeKey];
    if (!envelope || typeof envelope !== "object") {
      continue;
    }
    if (envelope.boxsInfo && typeof envelope.boxsInfo === "object") {
      return envelope.boxsInfo;
    }
    if (envelope.boxs_info && typeof envelope.boxs_info === "object") {
      return envelope.boxs_info;
    }
  }
  return payload;
}

/**
 * Moonraker/CFS-C material entry由来のpresenceを明示する。
 *
 * 【詳細説明】
 * - K2 `boxsInfo` はslot `state` を持つため、material名・色・RFIDだけで装填を推測しない。
 * - K1C/CFS-C Moonraker providerでは、`materials[]` に現れたentry自体を観測済みsourceとして扱う既存契約がある。
 * - 下流の観測ストアやViewModelがmetadataから装填を推測しないよう、provider境界で `presence:"loaded"` を明示する。
 * - explicitな `state` がある場合はnormalizer側の物理stateを優先し、providerで上書きしない。
 *
 * @private
 * @function annotateMoonrakerMaterialEntryPresence
 * @param {object} topology - 正規化済み material topology
 * @returns {object} Moonraker material entry presence を明示した topology
 */
function annotateMoonrakerMaterialEntryPresence(topology) {
  const sourceTopology = topology && typeof topology === "object" ? topology : normalizeK2BoxsInfo(null);
  const sources = Array.isArray(sourceTopology.sources) ? sourceTopology.sources : [];
  return {
    ...sourceTopology,
    sources: sources.map((source) => {
      if (!source || typeof source !== "object" || source.sourceIdentity?.valid === false) {
        return source;
      }
      const explicitPresence = String(source.presence || "").trim();
      if (explicitPresence) {
        return source;
      }
      if (source.observedFields?.status?.stateCode === true) {
        return source;
      }
      return {
        ...source,
        presence: "loaded",
        presenceEvidence: {
          sourceProtocol: "creality-moonraker-boxsInfo",
          reason: "observed-material-entry-without-state-code",
        },
      };
    }),
  };
}

/**
 * K1C/CFS-C Moonraker 用 read-only material provider を生成する。
 *
 * 【詳細説明】
 * - Moonraker provider は K1C 本体 identity を変更せず、CFS-C attachment を material topology としてだけ扱う。
 * - `normalizeBoxsInfo` は K2 と同じ topology contract を再利用し、実機 fixture で差分が出た場合は
 *   provider 変換層だけを拡張できるようにする。
 * - provider metadata には `transportKind:"moonraker"` を入れ、K2 WS9999 由来 topology と区別できるようにする。
 *
 * @function createCfsMoonrakerBoxMaterialProvider
 * @param {object=} options - provider 生成オプション
 * @param {Function=} options.normalizeBoxsInfo - `boxsInfo` を topology へ変換する関数
 * @param {Function=} options.extractBoxsInfo - Moonraker payload から `boxsInfo` を抽出する関数
 * @returns {object} K1C/CFS-C read-only material provider
 * @example
 * const provider = createCfsMoonrakerBoxMaterialProvider();
 */
export function createCfsMoonrakerBoxMaterialProvider(options = {}) {
  const normalizeBoxsInfo = typeof options.normalizeBoxsInfo === "function"
    ? options.normalizeBoxsInfo
    : normalizeK2BoxsInfo;
  const extractBoxsInfo = typeof options.extractBoxsInfo === "function"
    ? options.extractBoxsInfo
    : extractMoonrakerBoxsInfoPayload;
  const provider = {
    schemaVersion: MATERIAL_PROVIDER_SCHEMA_VERSION,
    providerId: "creality-cfs-moonraker-box",
    readOnly: true,
    supportsCfs: true,
    canDriveLedger: false,
    transportKind: "moonraker",
    sourceProtocol: "creality-moonraker-boxsInfo",
    /**
     * Moonraker/CFS-C payload を read-only material topology へ変換する。
     *
     * 【詳細説明】
     * - `boxsInfo` envelope の揺れを provider 境界で吸収し、NormalizedState 側は同じ material topology だけを見る。
     * - attach/detach の観測は topology の fresh/stale 診断材料であり、printer identity や ledger には書き込まない。
     *
     * @function createTopology
     * @param {object|null|undefined} payload - Moonraker/CFS-C 由来 payload
     * @param {object=} topologyOptions - topology 正規化オプション
     * @returns {object} provider metadata 付き material topology
     */
    createTopology(payload, topologyOptions = {}) {
      return attachMaterialProviderMetadata(
        annotateMoonrakerMaterialEntryPresence(normalizeBoxsInfo(extractBoxsInfo(payload), topologyOptions)),
        provider
      );
    },
  };
  return provider;
}
