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
 * - material 観測と filament ledger authority の境界を明示
 * - CFS 未接続時にも同一 shape の material topology を返す
 *
 * 【公開関数一覧】
 * - {@link createNoCfsMaterialProvider}：CFS 非対応/未観測用 material provider を生成
 * - {@link createCfsBoxsInfoMaterialProvider}：K2 `boxsInfo` 用 read-only material provider を生成
 *
 * @version 1.390.1312 (PR #432)
 * @since   1.390.1312 (PR #432)
 * @lastModified 2026-08-08 07:32:05
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
