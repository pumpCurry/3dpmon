/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource accounting 契約モジュール
 * @file dashboard_material_accounting_contract.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_contract
 *
 * 【機能内容サマリ】
 * - Gate 18.9A の FilamentUnit / MaterialSource / SpoolMount 純粋データ契約を提供
 * - K1 direct spool と K2/CFS multi-source を同じ accounting model で表現
 * - SpoolMount 継続と debit eligibility を分離する fail-closed 判定を提供
 *
 * 【公開関数一覧】
 * - {@link createDirectFeedUnitIdentity}：direct feed unit identity を生成
 * - {@link createMaterialSourceLocator}：MaterialSource の物理/protocol locator を生成
 * - {@link createMaterialSourceIdentity}：MaterialSource identity evidence を生成
 * - {@link createFilamentUnitRecord}：FilamentUnit record を生成
 * - {@link createMaterialSourceRecord}：MaterialSource record を生成
 * - {@link createSpoolMountRecord}：SpoolMount record を生成
 * - {@link createMaterialAccountingCutoverRecord}：legacy cutover record を生成
 * - {@link createMaterialSourceAccountingView}：UI用 read model contract を生成
 * - {@link validateFilamentUnit}：FilamentUnit record を検証
 * - {@link validateMaterialSource}：MaterialSource record を検証
 * - {@link validateSpoolMount}：SpoolMount record を検証
 * - {@link validateMaterialAccountingCutover}：cutover record を検証
 * - {@link evaluateMaterialDebitEligibility}：source-aware debit 可否を判定
 *
 * @version 1.390.1490 (PR #438)
 * @since   1.390.1490 (PR #438)
 * @lastModified 2026-08-31 09:39:54
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9B で JobMaterialSegment / FilamentLedger repository と接続する
 */

"use strict";

import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";

/**
 * Universal MaterialSource accounting contract version。
 *
 * @constant {number}
 */
export const MATERIAL_ACCOUNTING_CONTRACT_VERSION = 1;

/**
 * FilamentUnit 種別。
 *
 * 【詳細説明】
 * - direct spool もCFSと同じFilamentUnitとして扱い、N=1/N>1でdomain modelを分けない。
 *
 * @constant {Readonly<object>}
 */
export const FILAMENT_UNIT_KIND = Object.freeze({
  PRINTER_DIRECT: "printer-direct",
  CFS: "cfs",
  CFS_C: "cfs-c",
});

/**
 * MaterialSource 種別。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_SOURCE_KIND = Object.freeze({
  DIRECT_FEED: "direct-feed",
  EXTERNAL_SPOOL: "external-spool",
  CFS_SLOT: "cfs-slot",
  CFS_C_SLOT: "cfs-c-slot",
});

/**
 * MaterialSource / FilamentUnit identity 強度。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_IDENTITY_STRENGTH = Object.freeze({
  STABLE: "stable",
  PROVISIONAL: "provisional",
  UNKNOWN: "unknown",
});

/**
 * SpoolMount の状態。
 *
 * @constant {Readonly<object>}
 */
export const SPOOL_MOUNT_STATUS = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
  BLOCKED: "blocked",
});

/**
 * SpoolMount の確認方法。
 *
 * @constant {Readonly<object>}
 */
export const SPOOL_MOUNT_VERIFICATION = Object.freeze({
  OPERATOR_CONFIRMED: "operator-confirmed",
  MIGRATED: "migrated",
  LEGACY_PROJECTED: "legacy-projected",
  UNVERIFIED: "unverified",
});

/**
 * material accounting backend 種別。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_ACCOUNTING_BACKEND = Object.freeze({
  LEGACY_SINGLE_SOURCE: "legacy-single-source",
  UNIVERSAL_SHADOW: "universal-shadow",
  UNIVERSAL_AUTHORITATIVE: "universal-authoritative",
  BLOCKED_SOURCE_ATTRIBUTION: "blocked-source-attribution",
});

/**
 * source-aware debit 可否。
 *
 * @constant {Readonly<object>}
 */
export const DEBIT_ELIGIBILITY_STATUS = Object.freeze({
  ELIGIBLE: "eligible",
  PENDING: "pending",
  BLOCKED: "blocked",
});

/**
 * MaterialSourceAccountingView の usage state。
 *
 * @constant {ReadonlySet<string>}
 */
const MATERIAL_USAGE_VIEW_STATES = Object.freeze(new Set([
  "confirmed-used",
  "confirmed-unused",
  "unattributed",
  "unknown",
]));

/**
 * object value の許可集合を生成する。
 *
 * @private
 * @function enumValues
 * @param {Object} value - enum object。
 * @returns {Set<string>} enum値集合。
 */
function enumValues(value) {
  return new Set(Object.values(value));
}

/**
 * JSON互換値をcloneする。
 *
 * 【詳細説明】
 * - 契約recordは呼び出し側mutationで意味が変わると危険なため、生成時にcloneしてからfreezeする。
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
 * JSON互換objectを再帰freezeする。
 *
 * 【詳細説明】
 * - pure contract factoryの戻り値が後から書き換わり、検証済みの意味が崩れることを防ぐ。
 *
 * @private
 * @function deepFreezeJson
 * @param {*} value - freeze対象。
 * @returns {*} freeze済み値。
 */
function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return Object.freeze(value);
}

/**
 * 値をtrim済み文字列へ変換する。
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
 * 空でない文字列を要求する。
 *
 * @private
 * @function requireNonEmptyString
 * @param {*} value - 文字列候補。
 * @param {string} name - エラー表示用の項目名。
 * @returns {string} trim済み文字列。
 * @throws {TypeError} 空文字の場合。
 */
function requireNonEmptyString(value, name) {
  const text = toTrimmedString(value);
  if (!text) {
    throw new TypeError(`Material accounting contract requires a non-empty ${name}.`);
  }
  return text;
}

/**
 * enum値を正規化する。
 *
 * @private
 * @function normalizeEnumValue
 * @param {*} value - enum候補。
 * @param {ReadonlySet<string>} allowed - 許可値。
 * @param {string} fallback - fallback値。
 * @returns {string} 正規化済みenum値。
 */
function normalizeEnumValue(value, allowed, fallback) {
  const text = toTrimmedString(value || fallback);
  return allowed.has(text) ? text : fallback;
}

/**
 * 任意値を有限数またはnullへ正規化する。
 *
 * @private
 * @function toFiniteNumberOrNull
 * @param {*} value - 数値候補。
 * @returns {?number} 有限数、またはnull。
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean" || Array.isArray(value)) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * ISO日時文字列またはnullへ正規化する。
 *
 * @private
 * @function normalizeOptionalIsoTime
 * @param {*} value - 日時候補。
 * @returns {?string} ISO日時文字列、またはnull。
 */
function normalizeOptionalIsoTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * array候補を文字列配列へ正規化する。
 *
 * @private
 * @function normalizeStringArray
 * @param {*} value - 配列候補。
 * @returns {string[]} 空値を除いた文字列配列。
 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => toTrimmedString(entry)).filter(Boolean))];
}

/**
 * direct feed unit identityを生成する。
 *
 * 【詳細説明】
 * - K1/K1 Max/IR3/K2 external-onlyのN=1構成もFilamentUnitとして扱うためのidentity evidenceを生成する。
 * - 戻り値はdeterministic IDの入力として使うplain objectであり、database writeは行わない。
 *
 * @function createDirectFeedUnitIdentity
 * @param {Object} input - identity生成入力。
 * @param {string} input.deviceId - Device ID。
 * @param {string=} input.protocolFamily - printer protocol family。
 * @returns {Object} direct feed unit identity。
 * @example
 * const identity = createDirectFeedUnitIdentity({ deviceId: "serial:k1", protocolFamily: "creality-k1" });
 */
export function createDirectFeedUnitIdentity(input = {}) {
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  const protocolFamily = toTrimmedString(input.protocolFamily || "unknown");
  return deepFreezeJson({
    namespace: "filament-unit:printer-direct",
    parts: [deviceId, protocolFamily],
  });
}

/**
 * MaterialSource の物理/protocol locatorを生成する。
 *
 * 【詳細説明】
 * - locatorは現在観測された場所であり、MaterialSource IDそのものではない。
 * - CFS slotならbox/slot、direct/externalならindexを保持する。
 *
 * @function createMaterialSourceLocator
 * @param {Object} input - locator入力。
 * @param {string} input.kind - MaterialSource種別。
 * @param {number=} input.index - direct/external source index。
 * @param {number=} input.unitIndex - CFS/CFS-C unit index。
 * @param {number=} input.boxId - protocol box ID。
 * @param {number=} input.slotIndex - slot index。
 * @returns {Object} locator object。
 * @example
 * const locator = createMaterialSourceLocator({ kind: "cfs-slot", unitIndex: 1, slotIndex: 0 });
 */
export function createMaterialSourceLocator(input = {}) {
  const kind = normalizeEnumValue(
    input.kind,
    enumValues(MATERIAL_SOURCE_KIND),
    MATERIAL_SOURCE_KIND.DIRECT_FEED
  );
  return deepFreezeJson({
    kind,
    index: toFiniteNumberOrNull(input.index),
    unitIndex: toFiniteNumberOrNull(input.unitIndex),
    boxId: toFiniteNumberOrNull(input.boxId),
    slotIndex: toFiniteNumberOrNull(input.slotIndex),
    protocolSlotId: toTrimmedString(input.protocolSlotId) || null,
  });
}

/**
 * MaterialSource identity evidenceを生成する。
 *
 * 【詳細説明】
 * - `materialSourceId`作成の入力に使うlossless identity evidenceを作る。
 * - 表示labelや`1A`のようなlocator名ではなく、device/unit/kind/slotの意味情報を保持する。
 *
 * @function createMaterialSourceIdentity
 * @param {Object} input - identity入力。
 * @param {string} input.deviceId - Device ID。
 * @param {string} input.unitId - FilamentUnit ID。
 * @param {string} input.kind - MaterialSource種別。
 * @param {number=} input.slotIndex - slot index。
 * @param {number=} input.index - direct/external index。
 * @returns {Object} MaterialSource identity evidence。
 * @example
 * const identity = createMaterialSourceIdentity({ deviceId, unitId, kind: "cfs-slot", slotIndex: 0 });
 */
export function createMaterialSourceIdentity(input = {}) {
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  const unitId = requireNonEmptyString(input.unitId, "unitId");
  const kind = normalizeEnumValue(
    input.kind,
    enumValues(MATERIAL_SOURCE_KIND),
    MATERIAL_SOURCE_KIND.DIRECT_FEED
  );
  return deepFreezeJson({
    namespace: "material-source",
    parts: [
      deviceId,
      unitId,
      kind,
      toFiniteNumberOrNull(input.slotIndex),
      toFiniteNumberOrNull(input.index),
    ],
  });
}

/**
 * FilamentUnit recordを生成する。
 *
 * 【詳細説明】
 * - このfactoryは純粋関数であり、IndexedDBやmonitorDataを書き換えない。
 * - `authority.canDriveLedger:false`で返し、Gate18.9Aのcontract-only境界を維持する。
 *
 * @function createFilamentUnitRecord
 * @param {Object} input - FilamentUnit入力。
 * @param {string} input.deviceId - Device ID。
 * @param {string} input.kind - unit種別。
 * @param {Object=} input.identity - identity evidence。
 * @param {string=} input.identityStrength - stable/provisional/unknown。
 * @param {string=} input.providerId - provider ID。
 * @param {number=} input.unitIndex - unit index。
 * @param {string[]=} input.aliases - alias一覧。
 * @returns {Object} FilamentUnit record。
 * @example
 * const unit = createFilamentUnitRecord({ deviceId, kind: FILAMENT_UNIT_KIND.CFS });
 */
export function createFilamentUnitRecord(input = {}) {
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  const kind = normalizeEnumValue(input.kind, enumValues(FILAMENT_UNIT_KIND), FILAMENT_UNIT_KIND.PRINTER_DIRECT);
  const identity = cloneJsonValue(input.identity || {
    namespace: "filament-unit",
    parts: [deviceId, kind, toFiniteNumberOrNull(input.unitIndex)],
  });
  const unitId = toTrimmedString(input.unitId) ||
    createPrinterCoreV3DeterministicId("filament-unit", [deviceId, kind, identity]);
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_CONTRACT_VERSION,
    unitId,
    deviceId,
    kind,
    unitIndex: toFiniteNumberOrNull(input.unitIndex),
    providerId: toTrimmedString(input.providerId) || null,
    identity,
    identityStrength: normalizeEnumValue(
      input.identityStrength,
      enumValues(MATERIAL_IDENTITY_STRENGTH),
      MATERIAL_IDENTITY_STRENGTH.PROVISIONAL
    ),
    aliases: normalizeStringArray(input.aliases),
    authority: {
      mode: "contract-only",
      canDriveLedger: false,
      canSendPhysicalCommands: false,
    },
  });
}

/**
 * MaterialSource recordを生成する。
 *
 * 【詳細説明】
 * - source IDはidentity evidenceからdeterministicに作る。
 * - locator/displayLabel/aliasesは人間やprotocol向けの情報であり、IDとは分離する。
 *
 * @function createMaterialSourceRecord
 * @param {Object} input - MaterialSource入力。
 * @param {string} input.deviceId - Device ID。
 * @param {string} input.unitId - FilamentUnit ID。
 * @param {string} input.kind - source種別。
 * @param {Object=} input.locator - source locator。
 * @param {Object=} input.identity - identity evidence。
 * @param {string=} input.identityStrength - stable/provisional/unknown。
 * @param {string=} input.displayLabel - 表示名。
 * @param {string[]=} input.aliases - alias一覧。
 * @returns {Object} MaterialSource record。
 * @example
 * const source = createMaterialSourceRecord({ deviceId, unitId, kind: MATERIAL_SOURCE_KIND.CFS_SLOT });
 */
export function createMaterialSourceRecord(input = {}) {
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  const unitId = requireNonEmptyString(input.unitId, "unitId");
  const kind = normalizeEnumValue(input.kind, enumValues(MATERIAL_SOURCE_KIND), MATERIAL_SOURCE_KIND.DIRECT_FEED);
  const locator = cloneJsonValue(input.locator || createMaterialSourceLocator({ kind, index: 0 }));
  const identity = cloneJsonValue(input.identity || createMaterialSourceIdentity({
    deviceId,
    unitId,
    kind,
    slotIndex: locator?.slotIndex,
    index: locator?.index,
  }));
  const materialSourceId = toTrimmedString(input.materialSourceId) ||
    createPrinterCoreV3DeterministicId("material-source", [identity]);
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_CONTRACT_VERSION,
    materialSourceId,
    deviceId,
    unitId,
    kind,
    locator,
    identity,
    identityStrength: normalizeEnumValue(
      input.identityStrength,
      enumValues(MATERIAL_IDENTITY_STRENGTH),
      MATERIAL_IDENTITY_STRENGTH.PROVISIONAL
    ),
    displayLabel: toTrimmedString(input.displayLabel) || null,
    aliases: normalizeStringArray(input.aliases),
    authority: {
      mode: "contract-only",
      canDriveLedger: false,
      canChangeSpoolMount: false,
    },
  });
}

/**
 * SpoolMount recordを生成する。
 *
 * 【詳細説明】
 * - SpoolMountは3DPmon operator-managed stateであり、device observationやphysical command結果では生成しない。
 * - Gate18.9Aではcontract-only recordとして返し、永続化は後続repositoryで行う。
 *
 * @function createSpoolMountRecord
 * @param {Object} input - SpoolMount入力。
 * @param {string} input.materialSourceId - MaterialSource ID。
 * @param {string} input.spoolId - managed spool ID。
 * @param {string=} input.status - open/closed/blocked。
 * @param {string=} input.verification - 確認方法。
 * @param {string=} input.sourceIdentityStrengthAtOpen - mount開始時のsource identity強度。
 * @param {string=} input.expectedRfid - operator確認済みRFID。
 * @param {string=} input.openedAt - mount開始日時。
 * @param {string=} input.closedAt - mount終了日時。
 * @param {string=} input.openedBy - mount開始者。
 * @param {string=} input.closedBy - mount終了者。
 * @returns {Object} SpoolMount record。
 * @example
 * const mount = createSpoolMountRecord({ materialSourceId, spoolId, openedBy: "operator" });
 */
export function createSpoolMountRecord(input = {}) {
  const materialSourceId = requireNonEmptyString(input.materialSourceId, "materialSourceId");
  const spoolId = requireNonEmptyString(input.spoolId, "spoolId");
  const openedAt = normalizeOptionalIsoTime(input.openedAt);
  const status = normalizeEnumValue(input.status, enumValues(SPOOL_MOUNT_STATUS), SPOOL_MOUNT_STATUS.OPEN);
  const mountId = toTrimmedString(input.mountId) ||
    createPrinterCoreV3DeterministicId("spool-mount", [materialSourceId, spoolId, openedAt || "open"]);
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_CONTRACT_VERSION,
    mountId,
    materialSourceId,
    spoolId,
    status,
    verification: normalizeEnumValue(
      input.verification,
      enumValues(SPOOL_MOUNT_VERIFICATION),
      SPOOL_MOUNT_VERIFICATION.UNVERIFIED
    ),
    sourceIdentityStrengthAtOpen: normalizeEnumValue(
      input.sourceIdentityStrengthAtOpen,
      enumValues(MATERIAL_IDENTITY_STRENGTH),
      MATERIAL_IDENTITY_STRENGTH.PROVISIONAL
    ),
    expectedRfid: toTrimmedString(input.expectedRfid) || null,
    openedAt,
    closedAt: normalizeOptionalIsoTime(input.closedAt),
    openedBy: toTrimmedString(input.openedBy) || null,
    closedBy: toTrimmedString(input.closedBy) || null,
    authority: {
      mode: "contract-only",
      canDebitRemaining: false,
      closesByObservation: false,
    },
  });
}

/**
 * legacy accounting cutover recordを生成する。
 *
 * 【詳細説明】
 * - Universal accountingへ移行する前に、legacy mount intervalを最終legacy jobで封印する証跡を表す。
 * - このrecordだけではwrite activationせず、repository実装でtransaction境界を追加する。
 *
 * @function createMaterialAccountingCutoverRecord
 * @param {Object} input - cutover入力。
 * @param {string} input.deviceId - Device ID。
 * @param {string} input.cutoverAt - cutover日時。
 * @param {string} input.cutoverPrintId - 最終legacy print ID。
 * @param {string} input.fromBackend - 移行元backend。
 * @param {string} input.toBackend - 移行先backend。
 * @param {string} input.migrationStatus - migration status。
 * @param {string=} input.reason - cutover理由。
 * @returns {Object} cutover record。
 * @example
 * const cutover = createMaterialAccountingCutoverRecord({ deviceId, cutoverAt, cutoverPrintId });
 */
export function createMaterialAccountingCutoverRecord(input = {}) {
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  const cutoverAt = normalizeOptionalIsoTime(input.cutoverAt) ||
    (() => { throw new TypeError("Material accounting contract requires a valid cutoverAt."); })();
  const cutoverPrintId = requireNonEmptyString(input.cutoverPrintId, "cutoverPrintId");
  const fromBackend = normalizeEnumValue(
    input.fromBackend,
    enumValues(MATERIAL_ACCOUNTING_BACKEND),
    MATERIAL_ACCOUNTING_BACKEND.LEGACY_SINGLE_SOURCE
  );
  const toBackend = normalizeEnumValue(
    input.toBackend,
    enumValues(MATERIAL_ACCOUNTING_BACKEND),
    MATERIAL_ACCOUNTING_BACKEND.UNIVERSAL_SHADOW
  );
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_CONTRACT_VERSION,
    cutoverId: toTrimmedString(input.cutoverId) ||
      createPrinterCoreV3DeterministicId("material-accounting-cutover", [
        deviceId,
        cutoverPrintId,
        fromBackend,
        toBackend,
      ]),
    deviceId,
    cutoverAt,
    cutoverPrintId,
    fromBackend,
    toBackend,
    migrationStatus: toTrimmedString(input.migrationStatus) || "planned",
    reason: toTrimmedString(input.reason) || null,
    authority: {
      mode: "contract-only",
      canActivateWrites: false,
    },
  });
}

/**
 * MaterialSourceAccountingViewを生成する。
 *
 * 【詳細説明】
 * - UI実装前にN=1/N>1共通read modelの最小shapeを固定する。
 * - `confirmed-unused`の0mmと`unknown`のnullを混同しない。
 *
 * @function createMaterialSourceAccountingView
 * @param {Object} input - view入力。
 * @param {string} input.deviceId - Device ID。
 * @param {string=} input.backend - accounting backend。
 * @param {Array<Object>=} input.sources - source view一覧。
 * @param {string[]=} input.warnings - warning一覧。
 * @returns {Object} MaterialSourceAccountingView。
 * @example
 * const view = createMaterialSourceAccountingView({ deviceId, sources: [] });
 */
export function createMaterialSourceAccountingView(input = {}) {
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  const backend = normalizeEnumValue(
    input.backend,
    enumValues(MATERIAL_ACCOUNTING_BACKEND),
    MATERIAL_ACCOUNTING_BACKEND.UNIVERSAL_SHADOW
  );
  const sources = (Array.isArray(input.sources) ? input.sources : []).map((source) => {
    const materialSourceId = requireNonEmptyString(source?.materialSourceId, "sources[].materialSourceId");
    const usageState = MATERIAL_USAGE_VIEW_STATES.has(source?.usage?.state)
      ? source.usage.state
      : "unknown";
    const usedLengthMm = usageState === "unknown"
      ? null
      : toFiniteNumberOrNull(source?.usage?.usedLengthMm);
    return {
      materialSourceId,
      displayLabel: toTrimmedString(source?.displayLabel) || materialSourceId,
      observation: cloneJsonValue(source?.observation || null),
      mount: cloneJsonValue(source?.mount || null),
      usage: {
        state: usageState,
        usedLengthMm: usageState === "confirmed-unused" ? (usedLengthMm ?? 0) : usedLengthMm,
        confidence: toTrimmedString(source?.usage?.confidence) || "unknown",
      },
    };
  });
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_CONTRACT_VERSION,
    deviceId,
    backend,
    mode: sources.length <= 1 ? "single-source" : "multi-source",
    sources,
    unattributedUsage: cloneJsonValue(input.unattributedUsage || []),
    warnings: normalizeStringArray(input.warnings),
  });
}

/**
 * validation error を積む。
 *
 * @private
 * @function requireField
 * @param {string[]} errors - error配列。
 * @param {Object} record - 検証対象。
 * @param {string} key - 必須key。
 * @returns {void}
 */
function requireField(errors, record, key) {
  if (!toTrimmedString(record?.[key])) {
    errors.push(`missing-${key}`);
  }
}

/**
 * FilamentUnit recordを検証する。
 *
 * @function validateFilamentUnit
 * @param {Object|null|undefined} record - 検証対象。
 * @returns {{ok: boolean, errors: string[]}} 検証結果。
 * @example
 * const validation = validateFilamentUnit(unit);
 */
export function validateFilamentUnit(record) {
  const errors = [];
  if (!record || typeof record !== "object") {
    return { ok: false, errors: ["record-not-object"] };
  }
  requireField(errors, record, "unitId");
  requireField(errors, record, "deviceId");
  if (!enumValues(FILAMENT_UNIT_KIND).has(record.kind)) {
    errors.push("invalid-kind");
  }
  if (!enumValues(MATERIAL_IDENTITY_STRENGTH).has(record.identityStrength)) {
    errors.push("invalid-identityStrength");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * MaterialSource recordを検証する。
 *
 * @function validateMaterialSource
 * @param {Object|null|undefined} record - 検証対象。
 * @returns {{ok: boolean, errors: string[]}} 検証結果。
 * @example
 * const validation = validateMaterialSource(source);
 */
export function validateMaterialSource(record) {
  const errors = [];
  if (!record || typeof record !== "object") {
    return { ok: false, errors: ["record-not-object"] };
  }
  requireField(errors, record, "materialSourceId");
  requireField(errors, record, "deviceId");
  requireField(errors, record, "unitId");
  if (!enumValues(MATERIAL_SOURCE_KIND).has(record.kind)) {
    errors.push("invalid-kind");
  }
  if (!record.locator || typeof record.locator !== "object") {
    errors.push("missing-locator");
  }
  if (!enumValues(MATERIAL_IDENTITY_STRENGTH).has(record.identityStrength)) {
    errors.push("invalid-identityStrength");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * SpoolMount recordを検証する。
 *
 * @function validateSpoolMount
 * @param {Object|null|undefined} record - 検証対象。
 * @returns {{ok: boolean, errors: string[]}} 検証結果。
 * @example
 * const validation = validateSpoolMount(mount);
 */
export function validateSpoolMount(record) {
  const errors = [];
  if (!record || typeof record !== "object") {
    return { ok: false, errors: ["record-not-object"] };
  }
  requireField(errors, record, "mountId");
  requireField(errors, record, "materialSourceId");
  requireField(errors, record, "spoolId");
  if (!enumValues(SPOOL_MOUNT_STATUS).has(record.status)) {
    errors.push("invalid-status");
  }
  if (!enumValues(SPOOL_MOUNT_VERIFICATION).has(record.verification)) {
    errors.push("invalid-verification");
  }
  if (record.status === SPOOL_MOUNT_STATUS.CLOSED && !record.closedAt) {
    errors.push("closedAt-required");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * legacy accounting cutover recordを検証する。
 *
 * @function validateMaterialAccountingCutover
 * @param {Object|null|undefined} record - 検証対象。
 * @returns {{ok: boolean, errors: string[]}} 検証結果。
 * @example
 * const validation = validateMaterialAccountingCutover(cutover);
 */
export function validateMaterialAccountingCutover(record) {
  const errors = [];
  if (!record || typeof record !== "object") {
    return { ok: false, errors: ["record-not-object"] };
  }
  requireField(errors, record, "cutoverId");
  requireField(errors, record, "deviceId");
  requireField(errors, record, "cutoverAt");
  requireField(errors, record, "cutoverPrintId");
  if (!enumValues(MATERIAL_ACCOUNTING_BACKEND).has(record.fromBackend)) {
    errors.push("invalid-fromBackend");
  }
  if (!enumValues(MATERIAL_ACCOUNTING_BACKEND).has(record.toBackend)) {
    errors.push("invalid-toBackend");
  }
  if (record.fromBackend === record.toBackend) {
    errors.push("backend-not-changing");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * usage evidence がsource-aware debitに使える形かを検査する。
 *
 * @private
 * @function validateUsageEvidenceForDebit
 * @param {Object|null|undefined} usageEvidence - usage evidence候補。
 * @returns {string[]} error/reason一覧。
 */
function validateUsageEvidenceForDebit(usageEvidence) {
  const reasons = [];
  const usedLengthMm = toFiniteNumberOrNull(usageEvidence?.usedLengthMm);
  if (usedLengthMm === null || usedLengthMm < 0) {
    reasons.push("usage-evidence-required");
  }
  if (usageEvidence?.attribution !== "source-specific") {
    reasons.push("source-specific-usage-required");
  }
  if (!toTrimmedString(usageEvidence?.idempotencyKey)) {
    reasons.push("idempotency-key-required");
  }
  return reasons;
}

/**
 * stable RFID mismatch が存在するかを判定する。
 *
 * 【詳細説明】
 * - observed RFID がnull/空文字の場合は「読めない」だけなのでmismatchにしない。
 * - expected/observedの両方が非空で異なる場合だけhard blockerにする。
 *
 * @private
 * @function hasRfidMismatch
 * @param {Object} mount - SpoolMount。
 * @param {Object} continuity - continuity evidence。
 * @returns {boolean} mismatchならtrue。
 */
function hasRfidMismatch(mount, continuity) {
  const expected = toTrimmedString(mount?.expectedRfid);
  const observed = toTrimmedString(continuity?.observedRfid);
  return Boolean(expected && observed && expected !== observed);
}

/**
 * source-aware debit eligibilityを判定する。
 *
 * 【詳細説明】
 * - SpoolMountがOPENであっても、そのまま自動debitできるとは限らない。
 * - provisional sourceではprint-start時点のfresh topologyとsource continuityを要求する。
 * - physical discontinuityやRFID mismatchはmountを閉じずにdebitだけを止める。
 *
 * @function evaluateMaterialDebitEligibility
 * @param {Object} input - 判定入力。
 * @param {Object} input.mount - SpoolMount record。
 * @param {Object} input.materialSource - MaterialSource recordまたは最小source情報。
 * @param {Object} input.usageEvidence - usage evidence。
 * @param {Object} input.printStartSnapshot - print-start immutable snapshot。
 * @param {Object=} input.continuity - continuity evidence。
 * @returns {{status: string, canDebit: boolean, reasons: string[]}} 判定結果。
 * @example
 * const result = evaluateMaterialDebitEligibility({ mount, materialSource, usageEvidence, printStartSnapshot });
 */
export function evaluateMaterialDebitEligibility(input = {}) {
  const mount = input.mount || null;
  const materialSource = input.materialSource || null;
  const continuity = input.continuity || {};
  const pending = [];
  const blocked = [];

  if (!mount || typeof mount !== "object") {
    blocked.push("mount-required");
  } else {
    const mountValidation = validateSpoolMount(mount);
    if (!mountValidation.ok) {
      blocked.push(...mountValidation.errors);
    }
    if (mount.status !== SPOOL_MOUNT_STATUS.OPEN) {
      blocked.push("mount-not-open");
    }
  }

  if (!materialSource || typeof materialSource !== "object") {
    blocked.push("material-source-required");
  } else if (mount?.materialSourceId && materialSource.materialSourceId && mount.materialSourceId !== materialSource.materialSourceId) {
    blocked.push("material-source-mismatch");
  }

  if (!input.printStartSnapshot || typeof input.printStartSnapshot !== "object") {
    blocked.push("print-start-snapshot-required");
  } else if (mount?.mountId && input.printStartSnapshot.mountId && input.printStartSnapshot.mountId !== mount.mountId) {
    blocked.push("print-start-snapshot-mount-mismatch");
  }

  blocked.push(...validateUsageEvidenceForDebit(input.usageEvidence));

  if (continuity.identityConflict === true) {
    blocked.push("identity-conflict");
  }
  if (continuity.physicalDiscontinuity) {
    blocked.push("physical-discontinuity");
  }
  if (hasRfidMismatch(mount, continuity)) {
    blocked.push("rfid-mismatch");
  }
  if (continuity.sourceContinuity === false) {
    pending.push("source-continuity-required");
  }

  const sourceStrength = materialSource?.identityStrength || mount?.sourceIdentityStrengthAtOpen;
  if (sourceStrength === MATERIAL_IDENTITY_STRENGTH.PROVISIONAL && continuity.freshTopology !== true) {
    pending.push("fresh-topology-required");
  }

  if (blocked.length > 0) {
    return deepFreezeJson({
      status: DEBIT_ELIGIBILITY_STATUS.BLOCKED,
      canDebit: false,
      reasons: [...new Set(blocked)],
    });
  }
  if (pending.length > 0) {
    return deepFreezeJson({
      status: DEBIT_ELIGIBILITY_STATUS.PENDING,
      canDebit: false,
      reasons: [...new Set(pending)],
    });
  }
  return deepFreezeJson({
    status: DEBIT_ELIGIBILITY_STATUS.ELIGIBLE,
    canDebit: true,
    reasons: [],
  });
}
