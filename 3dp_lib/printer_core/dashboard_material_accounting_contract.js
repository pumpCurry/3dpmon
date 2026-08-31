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
 * - {@link createSourceSpecificMaterialUsageEvidence}：未信頼のsource-specific usage evidence shapeを生成
 * - {@link createMaterialSourceAccountingView}：UI用 read model contract を生成
 * - {@link canTransitionMaterialAccountingMigrationStatus}：migration lifecycle遷移可否を判定
 * - {@link validateFilamentUnit}：FilamentUnit record を検証
 * - {@link validateMaterialSource}：MaterialSource record を検証
 * - {@link validateSpoolMount}：SpoolMount record を検証
 * - {@link validateMaterialAccountingCutover}：cutover record を検証
 * - {@link evaluateMaterialDebitEligibility}：source-aware debit 可否を判定
 *
 * @version 1.390.1503 (PR #438)
 * @since   1.390.1490 (PR #438)
 * @lastModified 2026-08-31 11:52:00
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
 * source-specific usage evidence 用の module-private secret。
 *
 * 【詳細説明】
 * - caller がplain objectへ`attribution:"source-specific"`を書くだけでdebit authorityを得る経路を防ぐ。
 * - Gate18.9Aではcontract内factory由来のobjectだけをsource-aware debit候補として扱う。
 *
 * @constant {string}
 */
const SOURCE_SPECIFIC_USAGE_EVIDENCE_SECRET = `printer-core-material-usage:${Date.now()}:${Math.random()}`;

/**
 * trusted source-specific usage evidence の参照集合。
 *
 * @constant {WeakSet<object>}
 */
const TRUSTED_SOURCE_SPECIFIC_USAGE_EVIDENCE = new WeakSet();

/**
 * trusted print-start material snapshot の参照集合。
 *
 * 【詳細説明】
 * - Gate18.9Aではpublic issuerを持たず、plain objectのsnapshotをauthorityとして扱わない。
 * - Gate18.9Bでprint-start composition/repositoryが接続された時点で、発行境界を追加する。
 *
 * @constant {WeakSet<object>}
 */
const TRUSTED_PRINT_START_MATERIAL_SNAPSHOTS = new WeakSet();

/**
 * source-specific usage evidence のsource/method policy。
 *
 * 【詳細説明】
 * - 任意のsource/methodがsource-specific authorityを名乗ることを防ぐため、初期contractでは既知の実測系だけをshapeとして許す。
 * - ここで許可されても未信頼evidenceであり、debit authorityはGate18.9Bのissuer/repositoryまで昇格しない。
 *
 * @constant {Readonly<object>}
 */
const SOURCE_SPECIFIC_USAGE_EVIDENCE_POLICY = Object.freeze({
  "trusted-physical-counter:source-counter": "exact",
  "firmware-source-specific:firmware-source": "high",
});

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
 * Universal accounting migration lifecycle status。
 *
 * 【詳細説明】
 * - migration plannerやrepositoryが独自のstatus語彙を増やさないよう、Gate18.9Aでlifecycleを固定する。
 * - `SEALED`はlegacy-single-sourceからuniversal-authoritativeへのatomic cutover完了時だけ有効にする。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_ACCOUNTING_MIGRATION_STATUS = Object.freeze({
  PLANNED: "planned",
  CANDIDATE: "candidate",
  READY: "ready",
  SHADOW: "shadow",
  BLOCKED: "blocked",
  FAILED: "failed",
  SEALED: "sealed",
});

/**
 * Universal accounting migration blocker/reason。
 *
 * 【詳細説明】
 * - plannerやUIが同じblockerを別文字列で表現しないよう、Gate18.9Aで理由語彙を固定する。
 * - legacy hostSpoolMapをmulti-source機器へblind migrationしないための判定理由をここへ集約する。
 *
 * @constant {Readonly<object>}
 */
export const MATERIAL_ACCOUNTING_MIGRATION_BLOCKER = Object.freeze({
  LEGACY_SPOOL_MAP_AMBIGUOUS_FOR_MULTI_SOURCE: "legacy-spool-map-ambiguous-for-multi-source",
  LEGACY_SPOOL_MAP_REQUIRES_SOURCE_CONFIRMATION: "legacy-spool-map-requires-source-confirmation",
  MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED: "material-topology-observation-required",
  OPEN_MOUNT_CONFLICT: "open-mount-conflict",
  LEGACY_INTERVAL_CONFLICT: "legacy-interval-conflict",
  SOURCE_IDENTITY_CONFLICT: "source-identity-conflict",
  DEVICE_IDENTITY_INSUFFICIENT: "device-identity-insufficient",
  LEGACY_SPOOL_MISSING: "legacy-spool-missing",
});

/**
 * Universal accounting migration lifecycle transition table。
 *
 * @private
 * @constant {Readonly<object>}
 */
const MATERIAL_ACCOUNTING_MIGRATION_TRANSITIONS = Object.freeze({
  [MATERIAL_ACCOUNTING_MIGRATION_STATUS.PLANNED]: Object.freeze([
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
  ]),
  [MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE]: Object.freeze([
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
  ]),
  [MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY]: Object.freeze([
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
  ]),
  [MATERIAL_ACCOUNTING_MIGRATION_STATUS.SHADOW]: Object.freeze([
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.SEALED,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.FAILED,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
  ]),
  [MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED]: Object.freeze([
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.FAILED,
  ]),
  [MATERIAL_ACCOUNTING_MIGRATION_STATUS.FAILED]: Object.freeze([
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.PLANNED,
    MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
  ]),
  [MATERIAL_ACCOUNTING_MIGRATION_STATUS.SEALED]: Object.freeze([]),
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
 * migration lifecycle statusを次状態へ遷移できるか判定する。
 *
 * 【詳細説明】
 * - dry-run plannerの`planned/candidate/ready/blocked`と、execution結果の`shadow/failed/sealed`を混同しないための境界を提供する。
 * - `SEALED`はauthority cutover完了後の終端状態として扱い、後続遷移を許可しない。
 *
 * @function canTransitionMaterialAccountingMigrationStatus
 * @param {string} fromStatus - 現在のmigration status。
 * @param {string} toStatus - 遷移先のmigration status。
 * @returns {boolean} 許可された遷移ならtrue。
 * @example
 * const allowed = canTransitionMaterialAccountingMigrationStatus("ready", "shadow");
 */
export function canTransitionMaterialAccountingMigrationStatus(fromStatus, toStatus) {
  const from = toTrimmedString(fromStatus);
  const to = toTrimmedString(toStatus);
  const allowed = MATERIAL_ACCOUNTING_MIGRATION_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
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
 * authority identity用enum値を厳密に検証する。
 *
 * 【詳細説明】
 * - unknown topologyをdirect-onlyへ誤変換しないため、identity factoryではfallbackしない。
 * - UI設定の正規化とは異なり、missing/invalidは呼び出し側の契約違反として例外にする。
 *
 * @private
 * @function requireEnumValue
 * @param {*} value - enum候補。
 * @param {ReadonlySet<string>} allowed - 許可値。
 * @param {string} name - エラー表示用の項目名。
 * @returns {string} 検証済みenum値。
 * @throws {TypeError} 許可値ではない場合。
 */
function requireEnumValue(value, allowed, name) {
  const text = toTrimmedString(value);
  if (!allowed.has(text)) {
    throw new TypeError(`Material accounting contract invalid ${name}.`);
  }
  return text;
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
 * 空値を許すISO日時を厳密に正規化する。
 *
 * 【詳細説明】
 * - persisted authority recordで壊れた日時をnull扱いすると、閉じたmountが開いているように見える。
 * - factory入力では日時が与えられた時点でvalid ISOへ正規化できることを要求する。
 *
 * @private
 * @function normalizeOptionalIsoTimeStrict
 * @param {*} value - 日時候補。
 * @param {string} name - エラー表示用の項目名。
 * @returns {?string} ISO日時文字列、またはnull。
 * @throws {TypeError} 空でない不正日時の場合。
 */
function normalizeOptionalIsoTimeStrict(value, name) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = normalizeOptionalIsoTime(value);
  if (!normalized) {
    throw new TypeError(`Material accounting contract requires a valid ${name}.`);
  }
  return normalized;
}

/**
 * 非負mm値を正規化する。
 *
 * @private
 * @function normalizeNonNegativeMm
 * @param {*} value - mm候補。
 * @returns {?number} 0以上の有限数、またはnull。
 */
function normalizeNonNegativeMm(value) {
  const numberValue = toFiniteNumberOrNull(value);
  return numberValue !== null && numberValue >= 0 ? numberValue : null;
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
 * @param {string=} input.protocolFamily - printer protocol family。identityには含めずprovenance用途に留める。
 * @returns {Object} direct feed unit identity。
 * @example
 * const identity = createDirectFeedUnitIdentity({ deviceId: "serial:k1", protocolFamily: "creality-k1" });
 */
export function createDirectFeedUnitIdentity(input = {}) {
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  return deepFreezeJson({
    namespace: "filament-unit:printer-direct",
    parts: [deviceId, "printer-direct", 0],
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
  const kind = requireEnumValue(
    input.kind,
    enumValues(MATERIAL_SOURCE_KIND),
    "kind"
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
  const kind = requireEnumValue(
    input.kind,
    enumValues(MATERIAL_SOURCE_KIND),
    "kind"
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
  const kind = requireEnumValue(input.kind, enumValues(FILAMENT_UNIT_KIND), "kind");
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
  const kind = requireEnumValue(input.kind, enumValues(MATERIAL_SOURCE_KIND), "kind");
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
 * @param {string=} input.mountOperationId - mount操作の冪等identity。
 * @param {string=} input.openedAt - mount開始日時。
 * @param {string=} input.closedAt - mount終了日時。
 * @param {string=} input.openedBy - mount開始者。
 * @param {string=} input.closedBy - mount終了者。
 * @param {string=} input.closeOperationId - mount終了操作の冪等identity。
 * @param {string=} input.closeReason - mount終了理由。
 * @returns {Object} SpoolMount record。
 * @example
 * const mount = createSpoolMountRecord({ materialSourceId, spoolId, openedBy: "operator" });
 */
export function createSpoolMountRecord(input = {}) {
  const materialSourceId = requireNonEmptyString(input.materialSourceId, "materialSourceId");
  const spoolId = requireNonEmptyString(input.spoolId, "spoolId");
  const openedAt = normalizeOptionalIsoTimeStrict(input.openedAt, "openedAt");
  const rawStatus = toTrimmedString(input.status);
  const status = rawStatus
    ? requireEnumValue(rawStatus, enumValues(SPOOL_MOUNT_STATUS), "status")
    : SPOOL_MOUNT_STATUS.OPEN;
  const mountOperationId = toTrimmedString(input.mountOperationId);
  if (!mountOperationId) {
    throw new TypeError("Material accounting contract requires mountOperationId.");
  }
  const closedAt = normalizeOptionalIsoTimeStrict(input.closedAt, "closedAt");
  if (status === SPOOL_MOUNT_STATUS.OPEN && closedAt) {
    throw new TypeError("Material accounting contract mount-status-time-conflict.");
  }
  if (status === SPOOL_MOUNT_STATUS.CLOSED && !closedAt) {
    throw new TypeError("Material accounting contract requires closedAt for closed mount.");
  }
  if (openedAt && closedAt && Date.parse(closedAt) <= Date.parse(openedAt)) {
    throw new TypeError("Material accounting contract invalid mount interval.");
  }
  const mountId = toTrimmedString(input.mountId) ||
    createPrinterCoreV3DeterministicId("spool-mount", [materialSourceId, spoolId, mountOperationId]);
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_CONTRACT_VERSION,
    mountId,
    mountOperationId: mountOperationId || null,
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
    closedAt,
    openedBy: toTrimmedString(input.openedBy) || null,
    closedBy: toTrimmedString(input.closedBy) || null,
    closeOperationId: toTrimmedString(input.closeOperationId) || null,
    closeReason: toTrimmedString(input.closeReason) || null,
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
  const fromBackend = requireEnumValue(
    input.fromBackend,
    enumValues(MATERIAL_ACCOUNTING_BACKEND),
    "fromBackend"
  );
  const toBackend = requireEnumValue(
    input.toBackend,
    enumValues(MATERIAL_ACCOUNTING_BACKEND),
    "toBackend"
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
    migrationStatus: input.migrationStatus
      ? requireEnumValue(
        input.migrationStatus,
        enumValues(MATERIAL_ACCOUNTING_MIGRATION_STATUS),
        "migrationStatus"
      )
      : MATERIAL_ACCOUNTING_MIGRATION_STATUS.PLANNED,
    reason: toTrimmedString(input.reason) || null,
    authority: {
      mode: "contract-only",
      canActivateWrites: false,
    },
  });
}

/**
 * source-specific usage evidence signature を生成する。
 *
 * 【詳細説明】
 * - module-private secretを含め、plain object偽装やmutation後の意味破壊を検出する。
 *
 * @private
 * @function createSourceSpecificUsageEvidenceSignature
 * @param {Object} evidence - usage evidence。
 * @returns {string} deterministic signature。
 */
function createSourceSpecificUsageEvidenceSignature(evidence) {
  return createPrinterCoreV3DeterministicId("material-source-usage-evidence", [
    SOURCE_SPECIFIC_USAGE_EVIDENCE_SECRET,
    evidence.evidenceId,
    evidence.materialSourceId,
    evidence.mountId,
    evidence.snapshotId,
    evidence.printJobId,
    evidence.usedLengthMm,
    evidence.source,
    evidence.measurementMethod,
  ]);
}

/**
 * source-specific material usage evidence shapeを生成する。
 *
 * 【詳細説明】
 * - source-aware debit候補のshapeを、許可されたsource/method policyから生成する。
 * - public factoryはauthority attestationを発行しないため、戻り値だけでは`evaluateMaterialDebitEligibility()`を通過できない。
 *
 * @function createSourceSpecificMaterialUsageEvidence
 * @param {Object} input - usage evidence入力。
 * @param {string} input.materialSourceId - MaterialSource ID。
 * @param {string} input.mountId - SpoolMount ID。
 * @param {string} input.snapshotId - print-start snapshot ID。
 * @param {string} input.printJobId - PrintJob ID。
 * @param {string} input.deviceId - Device ID。
 * @param {string=} input.usageSegmentId - source-specific usage segment ID。
 * @param {string=} input.providerEventId - provider event ID。
 * @param {number=} input.segmentOrdinal - source内segment ordinal。
 * @param {number|string} input.usedLengthMm - 使用量mm。
 * @param {string} input.source - evidence source。
 * @param {string} input.measurementMethod - measurement method。
 * @param {string=} input.observedAt - 観測日時。
 * @param {string=} input.idempotencyKey - 冪等key。
 * @returns {Object} untrusted source-specific usage evidence。
 * @throws {TypeError} 必須値不足、不正な使用量、未許可source/methodの場合。
 * @example
 * const usage = createSourceSpecificMaterialUsageEvidence({ materialSourceId, mountId, snapshotId, printJobId, deviceId, usageSegmentId: "segment:0", usedLengthMm: 3210, source: "trusted-physical-counter", measurementMethod: "source-counter" });
 */
export function createSourceSpecificMaterialUsageEvidence(input = {}) {
  const materialSourceId = requireNonEmptyString(input.materialSourceId, "materialSourceId");
  const mountId = requireNonEmptyString(input.mountId, "mountId");
  const snapshotId = requireNonEmptyString(input.snapshotId, "snapshotId");
  const printJobId = requireNonEmptyString(input.printJobId, "printJobId");
  const deviceId = requireNonEmptyString(input.deviceId, "deviceId");
  const usedLengthMm = normalizeNonNegativeMm(input.usedLengthMm);
  if (usedLengthMm === null) {
    throw new TypeError("Material accounting contract requires a non-negative usedLengthMm.");
  }
  const source = requireNonEmptyString(input.source, "usage.source");
  const measurementMethod = requireNonEmptyString(input.measurementMethod, "usage.measurementMethod");
  const confidence = SOURCE_SPECIFIC_USAGE_EVIDENCE_POLICY[`${source}:${measurementMethod}`] || "unknown";
  if (confidence === "unknown") {
    throw new TypeError("Material accounting contract usage evidence source/method is not trusted.");
  }
  const observedAt = normalizeOptionalIsoTime(input.observedAt);
  const normalizedSegmentOrdinal = toFiniteNumberOrNull(input.segmentOrdinal);
  const usageSegmentId = toTrimmedString(input.usageSegmentId) ||
    toTrimmedString(input.providerEventId) ||
    (normalizedSegmentOrdinal !== null ? `segment:${normalizedSegmentOrdinal}` : "segment:0");
  const idempotencyKey = toTrimmedString(input.idempotencyKey) ||
    createPrinterCoreV3DeterministicId("material-source-usage-idempotency", [
      materialSourceId,
      snapshotId,
      printJobId,
      usageSegmentId,
    ]);
  const evidenceId = toTrimmedString(input.evidenceId) ||
    createPrinterCoreV3DeterministicId("material-source-usage-evidence", [
      materialSourceId,
      snapshotId,
      printJobId,
      idempotencyKey,
    ]);
  const evidence = {
    schemaVersion: MATERIAL_ACCOUNTING_CONTRACT_VERSION,
    evidenceId,
    materialSourceId,
    mountId,
    snapshotId,
    printJobId,
    deviceId,
    usageSegmentId,
    usedLengthMm,
    attribution: "source-specific",
    confidence,
    source,
    measurementMethod,
    observedAt,
    idempotencyKey,
    trusted: false,
    authority: {
      mode: "normalized-evidence-only",
      canDebit: false,
    },
    attestation: null,
  };
  return deepFreezeJson(evidence);
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
  requireField(errors, record, "mountOperationId");
  requireField(errors, record, "materialSourceId");
  requireField(errors, record, "spoolId");
  if (!enumValues(SPOOL_MOUNT_STATUS).has(record.status)) {
    errors.push("invalid-status");
  }
  if (!enumValues(SPOOL_MOUNT_VERIFICATION).has(record.verification)) {
    errors.push("invalid-verification");
  }
  const hasOpenedAt = record.openedAt !== null && record.openedAt !== undefined && record.openedAt !== "";
  const hasClosedAt = record.closedAt !== null && record.closedAt !== undefined && record.closedAt !== "";
  const openedAt = normalizeOptionalIsoTime(record.openedAt);
  const closedAt = normalizeOptionalIsoTime(record.closedAt);
  if (hasOpenedAt && !openedAt) {
    errors.push("invalid-mount-open-time");
  }
  if (hasClosedAt && !closedAt) {
    errors.push("invalid-mount-close-time");
  }
  if (record.status === SPOOL_MOUNT_STATUS.CLOSED && !hasClosedAt) {
    errors.push("closedAt-required");
  }
  if (record.status === SPOOL_MOUNT_STATUS.OPEN && hasClosedAt) {
    errors.push("mount-status-time-conflict");
  }
  if (openedAt && closedAt && Date.parse(closedAt) <= Date.parse(openedAt)) {
    errors.push("invalid-mount-interval");
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
  if (!enumValues(MATERIAL_ACCOUNTING_MIGRATION_STATUS).has(record.migrationStatus)) {
    errors.push("invalid-migrationStatus");
  }
  if (record.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.SEALED) {
    if (record.fromBackend !== MATERIAL_ACCOUNTING_BACKEND.LEGACY_SINGLE_SOURCE) {
      errors.push("sealed-cutover-source-required");
    }
    if (record.toBackend !== MATERIAL_ACCOUNTING_BACKEND.UNIVERSAL_AUTHORITATIVE) {
      errors.push("sealed-cutover-target-required");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * usage evidence がsource-aware debitに使える形かを検査する。
 *
 * @private
 * @function validateUsageEvidenceForDebit
 * @param {Object|null|undefined} usageEvidence - usage evidence候補。
 * @param {Object|null|undefined} mount - SpoolMount record。
 * @param {Object|null|undefined} materialSource - MaterialSource recordまたは最小source情報。
 * @param {Object|null|undefined} snapshot - print-start immutable snapshot候補。
 * @returns {string[]} error/reason一覧。
 */
function validateUsageEvidenceForDebit(usageEvidence, mount, materialSource, snapshot) {
  const reasons = [];
  const usedLengthMm = normalizeNonNegativeMm(usageEvidence?.usedLengthMm);
  if (usedLengthMm === null) {
    reasons.push("usage-evidence-required");
  }
  if (usageEvidence?.attribution !== "source-specific") {
    reasons.push("source-specific-usage-required");
  }
  if (!toTrimmedString(usageEvidence?.idempotencyKey)) {
    reasons.push("idempotency-key-required");
  }
  const usageSourceId = toTrimmedString(usageEvidence?.materialSourceId);
  const usageMountId = toTrimmedString(usageEvidence?.mountId);
  const usageSnapshotId = toTrimmedString(usageEvidence?.snapshotId);
  const usagePrintJobId = toTrimmedString(usageEvidence?.printJobId);
  const usageDeviceId = toTrimmedString(usageEvidence?.deviceId);
  const mountSourceId = toTrimmedString(mount?.materialSourceId);
  const sourceId = toTrimmedString(materialSource?.materialSourceId);
  const sourceDeviceId = toTrimmedString(materialSource?.deviceId);
  const mountId = toTrimmedString(mount?.mountId);
  const snapshotId = toTrimmedString(snapshot?.snapshotId);
  const snapshotPrintJobId = toTrimmedString(snapshot?.printJobId);
  const snapshotDeviceId = toTrimmedString(snapshot?.deviceId);
  if (!usageSourceId) {
    reasons.push("usage-evidence-source-required");
  } else if ((sourceId && usageSourceId !== sourceId) || (mountSourceId && usageSourceId !== mountSourceId)) {
    reasons.push("usage-evidence-source-mismatch");
  }
  if (!usageMountId) {
    reasons.push("usage-evidence-mount-required");
  } else if (mountId && usageMountId !== mountId) {
    reasons.push("usage-evidence-mount-mismatch");
  }
  if (!usageSnapshotId) {
    reasons.push("usage-evidence-snapshot-required");
  } else if (snapshotId && usageSnapshotId !== snapshotId) {
    reasons.push("usage-evidence-snapshot-mismatch");
  }
  if (!usagePrintJobId) {
    reasons.push("usage-evidence-job-required");
  } else if (snapshotPrintJobId && usagePrintJobId !== snapshotPrintJobId) {
    reasons.push("usage-evidence-job-mismatch");
  }
  if (!usageDeviceId) {
    reasons.push("usage-evidence-device-required");
  } else if ((sourceDeviceId && usageDeviceId !== sourceDeviceId) || (snapshotDeviceId && usageDeviceId !== snapshotDeviceId)) {
    reasons.push("usage-evidence-device-mismatch");
  }
  if (usageEvidence?.trusted !== true ||
      !TRUSTED_SOURCE_SPECIFIC_USAGE_EVIDENCE.has(usageEvidence) ||
      usageEvidence?.attestation !== createSourceSpecificUsageEvidenceSignature(usageEvidence)) {
    reasons.push("untrusted-usage-evidence");
  }
  return reasons;
}

/**
 * print-start snapshot がSpoolMount/MaterialSourceへbindされているかを検査する。
 *
 * 【詳細説明】
 * - 印刷完了時のcurrent mount参照による事後帰属を防ぐため、snapshotにはmount/source/spoolの固定値を必須にする。
 * - snapshotの値が現在入力と矛盾する場合は、自動debitの前提が崩れるためblockerとして返す。
 *
 * @private
 * @function validatePrintStartSnapshotForDebit
 * @param {Object|null|undefined} snapshot - print-start immutable snapshot候補。
 * @param {Object|null|undefined} mount - SpoolMount record。
 * @param {Object|null|undefined} materialSource - MaterialSource recordまたは最小source情報。
 * @returns {string[]} error/reason一覧。
 */
function validatePrintStartSnapshotForDebit(snapshot, mount, materialSource) {
  const reasons = [];
  if (!snapshot || typeof snapshot !== "object") {
    return ["print-start-snapshot-required"];
  }
  const snapshotId = toTrimmedString(snapshot.snapshotId);
  const snapshotDeviceId = toTrimmedString(snapshot.deviceId);
  const snapshotPrintJobId = toTrimmedString(snapshot.printJobId);
  const snapshotMountId = toTrimmedString(snapshot.mountId);
  const snapshotSourceId = toTrimmedString(snapshot.materialSourceId);
  const snapshotSpoolId = toTrimmedString(snapshot.spoolId);
  const snapshotCapturedAt = normalizeOptionalIsoTime(snapshot.capturedAt);
  const mountId = toTrimmedString(mount?.mountId);
  const mountSourceId = toTrimmedString(mount?.materialSourceId);
  const sourceId = toTrimmedString(materialSource?.materialSourceId);
  const sourceDeviceId = toTrimmedString(materialSource?.deviceId);
  const mountSpoolId = toTrimmedString(mount?.spoolId);
  if (!snapshotId) {
    reasons.push("print-start-snapshot-id-required");
  }
  if (!snapshotDeviceId) {
    reasons.push("print-start-snapshot-device-required");
  }
  if (!sourceDeviceId) {
    reasons.push("material-source-device-required");
  } else if (snapshotDeviceId && snapshotDeviceId !== sourceDeviceId) {
    reasons.push("print-start-snapshot-device-mismatch");
  }
  if (!snapshotPrintJobId) {
    reasons.push("print-start-snapshot-job-required");
  }
  if (!snapshotMountId) {
    reasons.push("print-start-snapshot-mount-required");
  } else if (mountId && snapshotMountId !== mountId) {
    reasons.push("print-start-snapshot-mount-mismatch");
  }
  if (!snapshotSourceId) {
    reasons.push("print-start-snapshot-source-required");
  } else if ((sourceId && snapshotSourceId !== sourceId) || (mountSourceId && snapshotSourceId !== mountSourceId)) {
    reasons.push("print-start-snapshot-source-mismatch");
  }
  if (!snapshotSpoolId) {
    reasons.push("print-start-snapshot-spool-required");
  } else if (mountSpoolId && snapshotSpoolId !== mountSpoolId) {
    reasons.push("print-start-snapshot-spool-mismatch");
  }
  if (!snapshotCapturedAt) {
    reasons.push("print-start-snapshot-time-required");
  }
  if (!TRUSTED_PRINT_START_MATERIAL_SNAPSHOTS.has(snapshot)) {
    reasons.push("untrusted-print-start-snapshot");
  }
  return reasons;
}

/**
 * print-start時点でmount intervalが有効だったかを検査する。
 *
 * 【詳細説明】
 * - 印刷完了後にoperatorがmountを閉じても、print-start時点でopenなら帰属候補として扱う。
 * - 逆にsnapshot取得時点より前に閉じたmountは、現在statusだけではなく時間区間で拒否する。
 *
 * @private
 * @function validateMountIntervalForSnapshot
 * @param {Object|null|undefined} mount - SpoolMount record。
 * @param {Object|null|undefined} snapshot - print-start snapshot候補。
 * @returns {string[]} reason一覧。
 */
function validateMountIntervalForSnapshot(mount, snapshot) {
  if (!mount || typeof mount !== "object") {
    return [];
  }
  if (mount.status === SPOOL_MOUNT_STATUS.BLOCKED) {
    return ["mount-not-open"];
  }
  const capturedAt = normalizeOptionalIsoTime(snapshot?.capturedAt);
  const openedAt = normalizeOptionalIsoTime(mount.openedAt);
  const closedAt = normalizeOptionalIsoTime(mount.closedAt);
  const hasOpenedAt = mount.openedAt !== null && mount.openedAt !== undefined && mount.openedAt !== "";
  const hasClosedAt = mount.closedAt !== null && mount.closedAt !== undefined && mount.closedAt !== "";
  if (!capturedAt) {
    return [];
  }
  if (hasOpenedAt && !openedAt) {
    return ["invalid-mount-open-time"];
  }
  if (hasClosedAt && !closedAt) {
    return ["invalid-mount-close-time"];
  }
  if (!openedAt) {
    return ["mount-open-time-required"];
  }
  const capturedTime = Date.parse(capturedAt);
  if (Date.parse(openedAt) > capturedTime) {
    return ["mount-not-open-at-print-start"];
  }
  if (closedAt && Date.parse(closedAt) <= capturedTime) {
    return ["mount-not-open-at-print-start"];
  }
  return [];
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
    blocked.push(...validateMountIntervalForSnapshot(mount, input.printStartSnapshot));
    if (mount.verification === SPOOL_MOUNT_VERIFICATION.UNVERIFIED) {
      blocked.push("mount-verification-required");
    }
    if (mount.verification === SPOOL_MOUNT_VERIFICATION.LEGACY_PROJECTED) {
      blocked.push("legacy-projection-not-debit-authority");
    }
    if (mount.verification === SPOOL_MOUNT_VERIFICATION.MIGRATED) {
      blocked.push("trusted-migration-evidence-required");
    }
  }

  if (!materialSource || typeof materialSource !== "object") {
    blocked.push("material-source-required");
  } else {
    const materialSourceId = toTrimmedString(materialSource.materialSourceId);
    if (!materialSourceId) {
      blocked.push("material-source-id-required");
    } else if (mount?.materialSourceId && mount.materialSourceId !== materialSourceId) {
      blocked.push("material-source-mismatch");
    }
    if (!toTrimmedString(materialSource.deviceId)) {
      blocked.push("material-source-device-required");
    }
  }

  blocked.push(...validatePrintStartSnapshotForDebit(input.printStartSnapshot, mount, materialSource));

  blocked.push(...validateUsageEvidenceForDebit(input.usageEvidence, mount, materialSource, input.printStartSnapshot));

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

  const identityStrengthValues = enumValues(MATERIAL_IDENTITY_STRENGTH);
  const sourceStrength = normalizeEnumValue(
    materialSource?.identityStrength,
    identityStrengthValues,
    MATERIAL_IDENTITY_STRENGTH.UNKNOWN
  );
  const mountSourceStrength = normalizeEnumValue(
    mount?.sourceIdentityStrengthAtOpen,
    identityStrengthValues,
    MATERIAL_IDENTITY_STRENGTH.UNKNOWN
  );
  if (sourceStrength === MATERIAL_IDENTITY_STRENGTH.UNKNOWN ||
      mountSourceStrength === MATERIAL_IDENTITY_STRENGTH.UNKNOWN) {
    blocked.push("source-identity-required");
  }
  if (sourceStrength === MATERIAL_IDENTITY_STRENGTH.PROVISIONAL) {
    if (continuity.freshTopology !== true) {
      pending.push("fresh-topology-required");
    }
    if (continuity.sourceContinuity !== true) {
      pending.push("source-continuity-required");
    }
  }

  if (blocked.length > 0) {
    return deepFreezeJson({
      status: DEBIT_ELIGIBILITY_STATUS.BLOCKED,
      canDebit: false,
      reasons: [...new Set([...blocked, ...pending])],
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
