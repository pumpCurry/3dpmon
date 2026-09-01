/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 MaterialSource print binding authority semantic モジュール
 * @file dashboard_material_accounting_print_binding_authority.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_print_binding_authority
 *
 * 【機能内容サマリ】
 * - print-start snapshot のdebit authorityに使うcanonical semanticを生成
 * - UI/diagnostic payloadとsource/spool/tool authorityを分離
 * - trusted snapshot signatureに束縛するdigestを提供
 *
 * 【公開関数一覧】
 * - {@link createPrintStartMaterialBindingAuthority}：snapshot用canonical binding authorityを生成
 * - {@link createPrintStartMaterialBindingAuthorityDigest}：binding authority digestを生成
 *
 * @version 1.390.1629 (PR #440)
 * @since   1.390.1629 (PR #440)
 * @lastModified 2026-09-02 08:35:23
 * -----------------------------------------------------------
 * @todo
 * - none
 */

"use strict";

import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";

/**
 * JSON互換値をcloneする。
 *
 * @private
 * @function cloneJsonValue
 * @param {*} value - clone対象。
 * @returns {*} clone済み値。
 */
function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * 文字列候補をtrim済み文字列へ変換する。
 *
 * @private
 * @function toTrimmedString
 * @param {*} value - 文字列候補。
 * @returns {string} trim済み文字列。
 */
function toTrimmedString(value) {
  return String(value ?? "").trim();
}

/**
 * 値を有限数へ正規化する。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 数値候補。
 * @returns {number|null} 有限数、またはnull。
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "" || Array.isArray(value)) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * ISO時刻候補を正規化する。
 *
 * @private
 * @function normalizeOptionalIsoTime
 * @param {*} value - 時刻候補。
 * @returns {string|null} ISO時刻、またはnull。
 */
function normalizeOptionalIsoTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * 文字列配列を安定順で正規化する。
 *
 * @private
 * @function normalizeStringArray
 * @param {*} value - 文字列配列候補。
 * @returns {string[]} 正規化済み文字列配列。
 */
function normalizeStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(toTrimmedString)
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

/**
 * bindingAuthorityへ保存するsource semanticを生成する。
 *
 * 【詳細説明】
 * - displayLabelやUI用material metadataはauthorityに含めない。
 * - 物理/protocol locator、source identity、alias集合だけをdebit判定用semanticとして固定する。
 *
 * @private
 * @function createBindingAuthoritySource
 * @param {Object} input - print-start snapshot入力。
 * @returns {Object} canonical source semantic。
 */
function createBindingAuthoritySource(input = {}) {
  const source = input.materialSource || input.source || {};
  return {
    materialSourceId: toTrimmedString(input.materialSourceId || source.materialSourceId || source.sourceId),
    deviceId: toTrimmedString(input.deviceId || source.deviceId),
    unitId: toTrimmedString(source.unitId) || null,
    kind: toTrimmedString(source.kind) || null,
    identityStrength: toTrimmedString(source.identityStrength || source.materialSourceIdentityStrength) || null,
    identity: cloneJsonValue(source.identity || null),
    locator: cloneJsonValue(source.locator || null),
    aliases: normalizeStringArray(source.aliases),
  };
}

/**
 * bindingAuthorityへ保存するmount semanticを生成する。
 *
 * 【詳細説明】
 * - print-start時点のdebit authorityに必要なmount ID、spool ID、開放時刻、確認状態だけを固定する。
 * - diagnostic用のmaterial名や表示色などはここへ入れず、後続の表示変更でauthority digestが揺れないようにする。
 *
 * @private
 * @function createBindingAuthorityMount
 * @param {Object} input - print-start snapshot入力。
 * @returns {Object} canonical mount semantic。
 */
function createBindingAuthorityMount(input = {}) {
  const mount = input.spoolMount || input.mount || {};
  return {
    mountId: toTrimmedString(input.mountId || mount.mountId),
    mountOperationId: toTrimmedString(mount.mountOperationId) || null,
    materialSourceId: toTrimmedString(input.materialSourceId || mount.materialSourceId),
    spoolId: toTrimmedString(input.spoolId || mount.spoolId),
    openedAt: normalizeOptionalIsoTime(input.mountOpenedAt || mount.openedAt),
    status: toTrimmedString(mount.status) || null,
    verification: toTrimmedString(mount.verification) || null,
    sourceIdentityStrengthAtOpen: toTrimmedString(mount.sourceIdentityStrengthAtOpen) || null,
    expectedRfid: toTrimmedString(mount.expectedRfid) || null,
    sourceIdentityDigestAtOpen: toTrimmedString(mount.sourceIdentityDigestAtOpen) || null,
  };
}

/**
 * print-start snapshot用canonical binding authorityを生成する。
 *
 * 【詳細説明】
 * - CFSのsource order、protocol tool alias、MaterialSource、SpoolMountのdebit semanticを1つに固定する。
 * - `snapshot.materialSource`や`snapshot.spoolMount`は診断用payloadとして残し、このauthorityだけをdebit判定へ渡す。
 *
 * @function createPrintStartMaterialBindingAuthority
 * @param {Object} input - print-start snapshot入力。
 * @returns {Object} canonical binding authority。
 * @example
 * const authority = createPrintStartMaterialBindingAuthority({ materialSource, spoolMount, toolId: 0 });
 */
export function createPrintStartMaterialBindingAuthority(input = {}) {
  return {
    schemaVersion: 1,
    tool: {
      toolId: toFiniteNumberOrNull(input.toolId),
      protocolToolAlias: toTrimmedString(input.protocolToolAlias || input.toolAlias) || null,
      order: toFiniteNumberOrNull(input.order),
    },
    source: createBindingAuthoritySource(input),
    mount: createBindingAuthorityMount(input),
  };
}

/**
 * binding authority digestを生成する。
 *
 * 【詳細説明】
 * - trusted snapshot signatureにはraw diagnostic objectではなく、このcanonical digestを束縛する。
 * - authorityに不要な表示用fieldが増えても、debit semanticが変わらない限りdigestは変化しない。
 *
 * @function createPrintStartMaterialBindingAuthorityDigest
 * @param {Object} authority - canonical binding authority。
 * @returns {string} deterministic digest。
 * @example
 * const digest = createPrintStartMaterialBindingAuthorityDigest(authority);
 */
export function createPrintStartMaterialBindingAuthorityDigest(authority = {}) {
  return createPrinterCoreV3DeterministicId("material-print-start-binding-authority", [
    stableStringifyPrinterCoreV3Value(authority && typeof authority === "object" && !Array.isArray(authority)
      ? authority
      : {}),
  ]);
}
