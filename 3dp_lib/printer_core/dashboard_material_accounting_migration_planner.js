/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration planner モジュール
 * @file dashboard_material_accounting_migration_planner.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_migration_planner
 *
 * 【機能内容サマリ】
 * - legacy hostSpoolMap を Universal MaterialSource accounting へ移す前のdry-run planを生成
 * - K1 direct-onlyとK2/CFS multi-sourceをprinterTypeではなくsource数と観測証跡で分類
 * - multi-source機器へlegacy 1本スプールをblind migrationしないfail-closed境界を提供
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingMigrationDryRunPlan}：legacy dataからdry-run planを生成
 * - {@link validateMaterialAccountingMigrationDryRunPlan}：dry-run planを検証
 *
 * @version 1.390.1510 (PR #438)
 * @since   1.390.1502 (PR #438)
 * @lastModified 2026-08-31 13:22:00
 * -----------------------------------------------------------
 * @todo
 * - trusted print-start material binding snapshotとsource-specific usage evidenceは後続Gateで接続する
 */

"use strict";

import {
  FILAMENT_UNIT_KIND,
  MATERIAL_ACCOUNTING_MIGRATION_BLOCKER,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS,
  MATERIAL_IDENTITY_STRENGTH,
  MATERIAL_SOURCE_KIND,
  SPOOL_MOUNT_STATUS,
  SPOOL_MOUNT_VERIFICATION,
  createDirectFeedUnitIdentity,
  createFilamentUnitRecord,
  createMaterialSourceIdentity,
  createMaterialSourceLocator,
  createMaterialSourceRecord,
  validateFilamentUnit,
  validateMaterialSource,
  validateSpoolMount,
} from "./dashboard_material_accounting_contract.js";
import {
  createPrinterCoreV3DeterministicId,
  stableStringifyPrinterCoreV3Value,
} from "./dashboard_data_schema_v3.js";

/**
 * Material accounting migration dry-run plan のschema version。
 *
 * @constant {number}
 */
export const MATERIAL_ACCOUNTING_MIGRATION_PLAN_SCHEMA_VERSION = 1;

/**
 * dry-run plannerが直接返してよいmigration status集合。
 *
 * 【詳細説明】
 * - `SHADOW` / `FAILED` / `SEALED` は実行transactionやrepository failureの結果であり、dry-run分析だけでは発行しない。
 *
 * @constant {ReadonlySet<string>}
 */
const DRY_RUN_DECISION_STATUSES = Object.freeze(new Set([
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.PLANNED,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
  MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
]));

/**
 * migration plannerがfresh topologyとして扱う既定TTL。
 *
 * @constant {number}
 */
const DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS = 60_000;

/**
 * material topology観測時刻がplan作成時刻より未来に見える場合の既定許容clock skew。
 *
 * @constant {number}
 */
const DEFAULT_ALLOWED_CLOCK_SKEW_MS = 5_000;

/**
 * migration planner policy revision。
 *
 * 【詳細説明】
 * - READY判定に使う入力やポリシーが変わったとき、dry-run journalのchecksumが必ず変わるようにする。
 *
 * @constant {number}
 */
const MATERIAL_ACCOUNTING_MIGRATION_PLANNER_POLICY_REVISION = 4;

/**
 * JSON互換値をcloneする。
 *
 * 【詳細説明】
 * - dry-run planは呼び出し側mutationで意味が変わると危険なため、返却前にclone/freezeする。
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
 * JSON互換値を再帰freezeする。
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
 * 空でない文字列へ正規化する。
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
 * optional ISO日時へ正規化する。
 *
 * @private
 * @function normalizeOptionalIsoTime
 * @param {*} value - 日時候補。
 * @returns {?string} ISO日時、またはnull。
 */
function normalizeOptionalIsoTime(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * 有限数へ正規化する。
 *
 * @private
 * @function toFiniteNumber
 * @param {*} value - 数値候補。
 * @param {?number} fallback - fallback値。
 * @returns {?number} 有限数、またはfallback。
 */
function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

/**
 * object mapらしい値を返す。
 *
 * @private
 * @function asPlainObject
 * @param {*} value - object候補。
 * @returns {Object} plain object、または空object。
 */
function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * enum値集合を生成する。
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
 * printerTypeを小文字へ正規化する。
 *
 * @private
 * @function normalizePrinterType
 * @param {*} value - printerType候補。
 * @returns {string} 正規化済みprinterType。
 */
function normalizePrinterType(value) {
  return toTrimmedString(value).toLowerCase();
}

/**
 * legacy connectionTargetsを安全な配列へ正規化する。
 *
 * @private
 * @function getConnectionTargets
 * @param {Object} legacyData - legacy monitorData。
 * @returns {Array<Object>} connection target配列。
 */
function getConnectionTargets(legacyData) {
  const targets = legacyData?.appSettings?.connectionTargets;
  return Array.isArray(targets) ? targets : [];
}

/**
 * targetがlegacy host keyに対応するかを判定する。
 *
 * 【詳細説明】
 * - hostname key移行前後のデータを拾うため、hostnameとdest prefixの両方を見る。
 *
 * @private
 * @function isConnectionTargetForHost
 * @param {?Object} target - connection target候補。
 * @param {string} host - legacy host key。
 * @returns {boolean} 対象hostに対応する場合true。
 */
function isConnectionTargetForHost(target, host) {
  const hostname = toTrimmedString(target?.hostname);
  const dest = toTrimmedString(target?.dest);
  return hostname === host || dest === host || dest.startsWith(`${host}:`);
}

/**
 * target/machineからdevice identity証拠を解決する。
 *
 * 【詳細説明】
 * - Printer Core v3 identityがある場合はそれを優先する。
 * - legacy-only host keyはmigration candidateの追跡用に残すが、READY条件ではstable扱いしない。
 *
 * @private
 * @function resolveDeviceIdentityEvidence
 * @param {string} host - legacy host key。
 * @param {?Object} target - connection target。
 * @returns {{deviceId:string, identityStrength:string}} device identity証拠。
 */
function resolveDeviceIdentityEvidence(host, target) {
  const identity = target?.printerCoreV3Identity || {};
  const deviceId = toTrimmedString(identity.deviceIdSeed) ||
    toTrimmedString(identity.deviceId) ||
    `legacy-host:${host}`;
  const rawStrength = toTrimmedString(identity.identityStrength).toLowerCase();
  const identityStrength = rawStrength === "serial" ||
    rawStrength === "stable-machine-id" ||
    rawStrength === "machine" ||
    rawStrength === "stable"
    ? MATERIAL_IDENTITY_STRENGTH.STABLE
    : MATERIAL_IDENTITY_STRENGTH.PROVISIONAL;
  return { deviceId, identityStrength };
}

/**
 * connection targetに未解決のdevice identity conflictがあるか判定する。
 *
 * 【詳細説明】
 * - identity repositoryは衝突時に既存identityを守り、conflict evidenceを別fieldへ残す。
 * - migration plannerはその状態の既存identityをREADY根拠にせず、operator確認や再観測へ戻す。
 *
 * @private
 * @function hasOpenDeviceIdentityConflict
 * @param {?Object} target - connection target。
 * @returns {boolean} 未解決conflictがある場合true。
 */
function hasOpenDeviceIdentityConflict(target) {
  const conflicts = [
    target?.printerCoreV3IdentityConflict,
    ...(
      Array.isArray(target?.printerCoreV3IdentityConflicts)
        ? target.printerCoreV3IdentityConflicts
        : []
    ),
  ].filter(Boolean);
  return conflicts.some((conflict) => {
    if (!conflict || typeof conflict !== "object") {
      return false;
    }
    return toTrimmedString(conflict.status || "open") !== "resolved";
  });
}

/**
 * hostに対応するconnection targetを一意に解決する。
 *
 * 【詳細説明】
 * - legacy hostSpoolMapはhost keyしか持たないため、同一hostに複数のstable identityがある場合は
 *   first-matchせずBLOCKEDへ落とす。
 * - 同じdeviceIdへ収束する重複targetはhostname移行中の重複として許容し、先頭targetを代表にする。
 *
 * @private
 * @function resolveConnectionTargetForHost
 * @param {Array<Object>} targets - connection target配列。
 * @param {string} host - legacy host key。
 * @returns {Object} 解決結果。
 */
function resolveConnectionTargetForHost(targets, host) {
  const candidates = targets
    .filter((target) => isConnectionTargetForHost(target, host))
    .map((target) => ({
      target,
      ...resolveDeviceIdentityEvidence(host, target),
      hasOpenIdentityConflict: hasOpenDeviceIdentityConflict(target),
    }));
  if (candidates.length === 0) {
    return {
      status: "missing",
      target: null,
      deviceIdentity: resolveDeviceIdentityEvidence(host, null),
      candidates: [],
      hasOpenIdentityConflict: false,
    };
  }
  const stableDeviceIds = new Set(
    candidates
      .filter((candidate) => candidate.identityStrength === MATERIAL_IDENTITY_STRENGTH.STABLE)
      .map((candidate) => candidate.deviceId)
  );
  if (stableDeviceIds.size > 1) {
    return {
      status: "ambiguous",
      target: null,
      deviceIdentity: candidates[0],
      candidates: candidates.map(({ deviceId, identityStrength, hasOpenIdentityConflict }) => ({
        deviceId,
        identityStrength,
        hasOpenIdentityConflict,
      })),
      hasOpenIdentityConflict: candidates.some((candidate) => candidate.hasOpenIdentityConflict),
    };
  }
  return {
    status: "unique",
    target: candidates[0].target,
    deviceIdentity: candidates[0],
    candidates: candidates.map(({ deviceId, identityStrength, hasOpenIdentityConflict }) => ({
      deviceId,
      identityStrength,
      hasOpenIdentityConflict,
    })),
    hasOpenIdentityConflict: candidates.some((candidate) => candidate.hasOpenIdentityConflict),
  };
}

/**
 * host/deviceIdに対応するmaterial source observation recordを探す。
 *
 * @private
 * @function findObservationRecord
 * @param {Object} legacyData - legacy monitorData。
 * @param {string} host - legacy host key。
 * @param {string} deviceId - device ID。
 * @returns {?Object} 観測record、またはnull。
 */
function findObservationRecord(legacyData, host, deviceId) {
  const byDeviceId = asPlainObject(legacyData?.materialSourceObservations?.byDeviceId);
  if (byDeviceId[deviceId]) {
    return byDeviceId[deviceId];
  }
  return Object.values(byDeviceId).find((record) => {
    return record && typeof record === "object" &&
      (record.deviceId === deviceId || record.host === host);
  }) || null;
}

/**
 * legacy spool IDが現在のspool一覧に存在するか判定する。
 *
 * @private
 * @function hasLegacySpoolRecord
 * @param {Object} legacyData - legacy monitorData。
 * @param {string} spoolId - spool ID。
 * @returns {boolean} spool実体が存在する場合true。
 */
function hasLegacySpoolRecord(legacyData, spoolId) {
  const spools = Array.isArray(legacyData?.filamentSpools) ? legacyData.filamentSpools : [];
  return spools.some((spool) => toTrimmedString(spool?.id) === spoolId);
}

/**
 * migration専用confirmationがoperator確認済みsingle-spool構成を宣言しているか判定する。
 *
 * @private
 * @function hasOperatorConfirmedSingleSpoolConfiguration
 * @param {Object} input - confirmation判定入力。
 * @param {Array<Object>} input.confirmations - migration topology confirmation配列。
 * @param {string} input.deviceId - device ID。
 * @param {string} input.host - legacy host key。
 * @param {string} input.migrationSubjectId - stable migration subject ID。
 * @param {string} input.confirmationEvidenceChecksum - confirmation前のdecision evidence checksum。
 * @param {string} input.confirmationRevisionId - confirmation前のdecision revision ID。
 * @returns {boolean} operator確認済みsingle-spoolならtrue。
 */
function hasOperatorConfirmedSingleSpoolConfiguration(input) {
  return input.confirmations.some((confirmation) => {
    if (!confirmation || typeof confirmation !== "object") {
      return false;
    }
    if (toTrimmedString(confirmation.mode) !== "single-spool") {
      return false;
    }
    if (toTrimmedString(confirmation.deviceId) !== input.deviceId) {
      return false;
    }
    if (toTrimmedString(confirmation.host) && toTrimmedString(confirmation.host) !== input.host) {
      return false;
    }
    if (!toTrimmedString(confirmation.confirmationId)) {
      return false;
    }
    if (!toTrimmedString(confirmation.confirmedBy)) {
      return false;
    }
    if (!normalizeOptionalIsoTime(confirmation.confirmedAt)) {
      return false;
    }
    const confirmationSubjectId = toTrimmedString(confirmation.migrationSubjectId);
    if (!confirmationSubjectId || confirmationSubjectId !== input.migrationSubjectId) {
      return false;
    }
    const confirmationPlanRevisionId = toTrimmedString(confirmation.planRevisionId);
    if (confirmationPlanRevisionId && confirmationPlanRevisionId !== input.confirmationRevisionId) {
      return false;
    }
    const confirmationEvidenceChecksum = toTrimmedString(confirmation.evidenceChecksum);
    if (!confirmationEvidenceChecksum || confirmationEvidenceChecksum !== input.confirmationEvidenceChecksum) {
      return false;
    }
    return true;
  });
}

/**
 * decision checksumへ含めるmigration topology confirmation投影を生成する。
 *
 * 【詳細説明】
 * - confirmation自身を最終planRevisionIdへbindするとchecksum循環が起きる。
 * - そのため、confirmation前のevidence checksumへbindされた確認だけを抽出し、最終decision checksumへ含める。
 *
 * @private
 * @function listAcceptedMigrationTopologyConfirmationEvidence
 * @param {Array<Object>} confirmations - migration topology confirmation候補。
 * @param {Object} input - 確認証跡のbind対象。
 * @param {string} input.migrationSubjectId - stable migration subject ID。
 * @param {string} input.confirmationEvidenceChecksum - confirmation前のdecision evidence checksum。
 * @param {string} input.confirmationRevisionId - confirmation前のdecision revision ID。
 * @returns {Array<Object>} checksum投入用に正規化したconfirmation一覧。
 */
function listAcceptedMigrationTopologyConfirmationEvidence(confirmations, input) {
  return confirmations
    .map((confirmation) => {
      if (!confirmation || typeof confirmation !== "object") {
        return null;
      }
      const confirmationId = toTrimmedString(confirmation.confirmationId);
      const deviceId = toTrimmedString(confirmation.deviceId);
      const host = toTrimmedString(confirmation.host);
      const mode = toTrimmedString(confirmation.mode);
      const confirmedBy = toTrimmedString(confirmation.confirmedBy);
      const confirmedAt = normalizeOptionalIsoTime(confirmation.confirmedAt);
      const migrationSubjectId = toTrimmedString(confirmation.migrationSubjectId);
      const evidenceChecksum = toTrimmedString(confirmation.evidenceChecksum);
      const planRevisionId = toTrimmedString(confirmation.planRevisionId);
      if (!confirmationId || !deviceId || mode !== "single-spool" || !confirmedBy || !confirmedAt) {
        return null;
      }
      if (migrationSubjectId !== input.migrationSubjectId ||
          evidenceChecksum !== input.confirmationEvidenceChecksum) {
        return null;
      }
      if (planRevisionId && planRevisionId !== input.confirmationRevisionId) {
        return null;
      }
      return {
        confirmationId,
        deviceId,
        host: host || null,
        mode,
        confirmedBy,
        confirmedAt,
        migrationSubjectId,
        evidenceChecksum,
        planRevisionId: planRevisionId || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => stableStringifyPrinterCoreV3Value(a).localeCompare(stableStringifyPrinterCoreV3Value(b)));
}

/**
 * legacyData/optionsからmigration topology confirmation一覧を抽出する。
 *
 * 【詳細説明】
 * - `materialSystem`は表示/接続設定であり、migration実行権限ではない。
 * - そのためconfirmationはmigration専用namespaceだけを読み、旧boolean fieldは無視する。
 *
 * @private
 * @function listMigrationTopologyConfirmations
 * @param {Object} legacyData - legacy monitorData。
 * @param {Object=} options - planner options。
 * @returns {Array<Object>} confirmation候補配列。
 */
function listMigrationTopologyConfirmations(legacyData, options = {}) {
  return [
    ...(Array.isArray(options.migrationTopologyConfirmations) ? options.migrationTopologyConfirmations : []),
    ...(Array.isArray(legacyData?.materialAccounting?.migrationTopologyConfirmations)
      ? legacyData.materialAccounting.migrationTopologyConfirmations
      : []),
    ...(Array.isArray(legacyData?.printerCoreV3MaterialAccountingMigrationTopologyConfirmations)
      ? legacyData.printerCoreV3MaterialAccountingMigrationTopologyConfirmations
      : []),
  ].map((confirmation) => cloneJsonValue(confirmation));
}

/**
 * materialAccounting snapshotからmigration confirmationだけを除外する。
 *
 * 【詳細説明】
 * - confirmationはdecisionを変える入力だが、confirmation前evidence checksum自身に含めると循環する。
 * - repository snapshotなどの移行判定に必要な情報は残し、confirmation配列だけを別投影で扱う。
 *
 * @private
 * @function createMaterialAccountingEvidenceProjection
 * @param {*} materialAccounting - legacy materialAccounting候補。
 * @returns {*} checksum用materialAccounting投影。
 */
function createMaterialAccountingEvidenceProjection(materialAccounting) {
  if (!materialAccounting || typeof materialAccounting !== "object" || Array.isArray(materialAccounting)) {
    return materialAccounting || null;
  }
  const projection = cloneJsonValue(materialAccounting);
  delete projection.migrationTopologyConfirmations;
  return Object.keys(projection).length > 0 ? projection : null;
}

/**
 * migration decision checksum用の証拠projectionを生成する。
 *
 * 【詳細説明】
 * - `confirmationEvidenceChecksum`生成時はaccepted confirmationsを空にする。
 * - 最終`source.checksum`生成時は、confirmation前evidenceへbindされた受理済みconfirmationだけを含める。
 *
 * @private
 * @function createDecisionEvidenceProjection
 * @param {Object} source - legacy monitorData互換source。
 * @param {Object} input - checksum生成入力。
 * @param {string} input.migrationSubjectId - stable migration subject ID。
 * @param {string} input.createdAt - plan作成日時。
 * @param {number} input.freshTtlMs - topology fresh TTL。
 * @param {number} input.allowedClockSkewMs - 未来観測許容clock skew。
 * @param {Object} input.hostSpoolMap - legacy hostSpoolMap。
 * @param {Array<Object>} input.acceptedMigrationTopologyConfirmations - 受理済みconfirmation投影。
 * @param {?string=} input.confirmationEvidenceChecksum - confirmation前evidence checksum。
 * @param {?string=} input.confirmationRevisionId - confirmation前evidence revision ID。
 * @returns {Object} checksum用decision evidence projection。
 */
function createDecisionEvidenceProjection(source, input) {
  return {
    plannerPolicyRevision: MATERIAL_ACCOUNTING_MIGRATION_PLANNER_POLICY_REVISION,
    planSchemaVersion: MATERIAL_ACCOUNTING_MIGRATION_PLAN_SCHEMA_VERSION,
    migrationSubjectId: input.migrationSubjectId,
    createdAt: input.createdAt,
    freshTtlMs: input.freshTtlMs,
    allowedClockSkewMs: input.allowedClockSkewMs,
    confirmationEvidenceChecksum: input.confirmationEvidenceChecksum || null,
    confirmationRevisionId: input.confirmationRevisionId || null,
    acceptedMigrationTopologyConfirmations: input.acceptedMigrationTopologyConfirmations,
    hostSpoolMap: input.hostSpoolMap,
    connectionTargets: getConnectionTargets(source),
    machines: asPlainObject(source.machines),
    filamentSpools: Array.isArray(source.filamentSpools) ? source.filamentSpools : [],
    materialSourceObservations: source.materialSourceObservations || null,
    materialAccounting: createMaterialAccountingEvidenceProjection(source.materialAccounting),
    printerCoreV3MaterialSourceRegistry: source.printerCoreV3MaterialSourceRegistry || null,
    materialSourceRegistry: source.materialSourceRegistry || null,
    printerCoreV3SpoolMountRepository: source.printerCoreV3SpoolMountRepository || null,
    spoolMountRepository: source.spoolMountRepository || null,
  };
}

/**
 * migration decision evidence projectionからchecksumを生成する。
 *
 * @private
 * @function createMigrationSourceChecksum
 * @param {Object} projection - decision evidence projection。
 * @returns {string} `fnv1a128:` prefixつきchecksum。
 */
function createMigrationSourceChecksum(projection) {
  return `fnv1a128:${createPrinterCoreV3DeterministicId("legacy-material-accounting-source", [
    stableStringifyPrinterCoreV3Value(projection),
  ]).split(":")[1]}`;
}

/**
 * hostSpoolMap全体を表すmigration batch IDを生成する。
 *
 * 【詳細説明】
 * - batch IDはdry-run plan全体の入力集合を表す。
 * - operator確認の対象には使わず、entry単位のsubjectと分離する。
 *
 * @private
 * @function createMigrationBatchId
 * @param {Object} hostSpoolMap - legacy hostSpoolMap。
 * @returns {string} plan全体のmigration batch ID。
 */
function createMigrationBatchId(hostSpoolMap) {
  return createPrinterCoreV3DeterministicId("material-accounting-migration-batch", [
    stableStringifyPrinterCoreV3Value({ hostSpoolMap }),
  ]);
}

/**
 * host-to-spool単位のmigration subject IDを生成する。
 *
 * 【詳細説明】
 * - 別hostのspool割当が変わっても、同一host/spoolのoperator確認を無効化しないためのentry単位ID。
 * - confirmationはこのIDとentry用evidence checksumへbindする。
 *
 * @private
 * @function createEntryMigrationSubjectId
 * @param {string} host - legacy host key。
 * @param {string} spoolId - legacy spool ID。
 * @returns {string} entry単位のmigration subject ID。
 */
function createEntryMigrationSubjectId(host, spoolId) {
  return createPrinterCoreV3DeterministicId("material-accounting-migration-subject", [
    stableStringifyPrinterCoreV3Value({ host, spoolId }),
  ]);
}

/**
 * entry confirmation用のdecision evidence bindingを生成する。
 *
 * 【詳細説明】
 * - migration confirmationはplan全体ではなく、host-to-spool単位の証拠へbindする。
 * - checksumはconfirmationを除いたsnapshotで生成し、revision IDはそのchecksumから派生させる。
 *
 * @private
 * @function createEntryConfirmationEvidenceBinding
 * @param {Object} source - legacy monitorData互換source。
 * @param {Object} input - entry evidence入力。
 * @param {string} input.host - legacy host key。
 * @param {string} input.spoolId - spool ID。
 * @param {string} input.createdAt - plan作成日時。
 * @param {number} input.freshTtlMs - topology fresh TTL。
 * @param {number} input.allowedClockSkewMs - 未来観測許容clock skew。
 * @returns {{migrationSubjectId:string, confirmationEvidenceChecksum:string, confirmationRevisionId:string}} binding。
 */
function createEntryConfirmationEvidenceBinding(source, input) {
  const migrationSubjectId = createEntryMigrationSubjectId(input.host, input.spoolId);
  const confirmationEvidenceChecksum = createMigrationSourceChecksum(createDecisionEvidenceProjection(source, {
    migrationSubjectId,
    createdAt: input.createdAt,
    freshTtlMs: input.freshTtlMs,
    allowedClockSkewMs: input.allowedClockSkewMs,
    acceptedMigrationTopologyConfirmations: [],
    hostSpoolMap: { [input.host]: input.spoolId },
  }));
  const confirmationRevisionId = createPrinterCoreV3DeterministicId(
    "material-accounting-confirmation-revision",
    [confirmationEvidenceChecksum]
  );
  return {
    migrationSubjectId,
    confirmationEvidenceChecksum,
    confirmationRevisionId,
  };
}

/**
 * target/machineがsingle-spool構成を示しているか判定する。
 *
 * @private
 * @function hasSingleSpoolConfiguration
 * @param {?Object} target - connection target。
 * @param {Object} machine - machine record。
 * @returns {boolean} single-spool構成ならtrue。
 */
function hasSingleSpoolConfiguration(target, machine) {
  const targetMode = toTrimmedString(target?.materialSystem?.mode);
  const machineMode = toTrimmedString(machine?.materialSystem?.mode);
  return targetMode === "single-spool" || machineMode === "single-spool";
}

/**
 * observation recordがREADY判定に使えるfresh complete topologyか判定する。
 *
 * 【詳細説明】
 * - partial delta、復元済みlast-known、provider切断、TTL切れは現在の物理topology証拠として扱わない。
 * - READYは後続repositoryへ適用可能な候補なので、単一source観測であってもfresh completeでなければBLOCKEDにする。
 *
 * @private
 * @function isFreshCompleteTopologyObservation
 * @param {?Object} observationRecord - material source observation record。
 * @param {Object} input - 判定入力。
 * @param {string} input.createdAt - plan作成日時。
 * @param {number} input.freshTtlMs - fresh扱いTTL。
 * @param {number} input.allowedClockSkewMs - 未来観測の許容clock skew。
 * @returns {boolean} fresh complete observationならtrue。
 */
function isFreshCompleteTopologyObservation(observationRecord, input) {
  if (!observationRecord || typeof observationRecord !== "object") {
    return false;
  }
  if (observationRecord.restoredFromStorage === true || observationRecord.providerDisconnectedAt) {
    return false;
  }
  if (observationRecord.snapshotCompleteness !== "complete") {
    return false;
  }
  const observedMs = Date.parse(observationRecord.lastObservedAt || "");
  const createdMs = Date.parse(input.createdAt || "");
  if (!Number.isFinite(observedMs) || !Number.isFinite(createdMs)) {
    return false;
  }
  const allowedClockSkewMs = Math.max(0, Math.floor(toFiniteNumber(input.allowedClockSkewMs, DEFAULT_ALLOWED_CLOCK_SKEW_MS) ?? DEFAULT_ALLOWED_CLOCK_SKEW_MS));
  if (observedMs - createdMs > allowedClockSkewMs) {
    return false;
  }
  const ttl = Math.max(1, Math.floor(toFiniteNumber(input.freshTtlMs, DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS) ?? DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS));
  return Math.max(0, createdMs - observedMs) <= ttl;
}

/**
 * observation recordからsource一覧を抽出する。
 *
 * @private
 * @function listObservedSources
 * @param {?Object} observationRecord - material source observation record。
 * @returns {Array<Object>} source snapshot配列。
 */
function listObservedSources(observationRecord) {
  return Object.values(asPlainObject(observationRecord?.latestBySourceId))
    .filter((source) => {
      if (!source || typeof source !== "object") {
        return false;
      }
      if (source.tombstoneAt) {
        return false;
      }
      if (toTrimmedString(source.presence) === "unobserved") {
        return false;
      }
      return true;
    })
    .map((source) => cloneJsonValue(source));
}

/**
 * source kindが単一direct扱いできるかを判定する。
 *
 * @private
 * @function isSingleDirectLikeSourceKind
 * @param {*} kind - source kind候補。
 * @returns {boolean} direct/externalならtrue。
 */
function isSingleDirectLikeSourceKind(kind) {
  return kind === MATERIAL_SOURCE_KIND.DIRECT_FEED ||
    kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ||
    kind === "direct" ||
    kind === "external";
}

/**
 * observation sourceがstable identityとしてmigrationへ使えるか判定する。
 *
 * 【詳細説明】
 * - observation側がidentityStrengthを明示しない旧read-only snapshotは、READYの証拠としては不足扱いにする。
 * - legacy hostSpoolMapをsource-aware mountへ変換する時点で、provisional sourceをstableとして再発行しない。
 *
 * @private
 * @function hasStableObservedSourceIdentity
 * @param {?Object} source - observed source snapshot。
 * @returns {boolean} stable source identityならtrue。
 */
function hasStableObservedSourceIdentity(source) {
  const explicitStrength = toTrimmedString(
    source?.sourceIdentityStrength ||
    source?.materialSourceIdentityStrength ||
    source?.identity?.identityStrength ||
    source?.identity?.strength
  ).toLowerCase();
  return explicitStrength === MATERIAL_IDENTITY_STRENGTH.STABLE ||
    explicitStrength === "stable";
}

/**
 * observation sourceからlocator入力を抽出する。
 *
 * 【詳細説明】
 * - Gate18.7のObservation Storeは`locator` objectだけでなく、top-levelの`boxId`、
 *   `slotId`、`protocolSlotId`へprotocol位置証拠を保持する。
 * - plannerはこの実shapeをMaterialSource locatorへ正規化し、index 0へ潰さない。
 *
 * @private
 * @function resolveObservedSourceLocatorInput
 * @param {?Object} source - observed source snapshot。
 * @returns {?Object} locator入力、またはnull。
 */
function resolveObservedSourceLocatorInput(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const kind = resolveObservedSourceKind(source);
  const locator = source.locator && typeof source.locator === "object" ? source.locator : {};
  const slotLikeIndex = toFiniteNumber(
    locator.index,
    toFiniteNumber(source.index, toFiniteNumber(source.slotIndex, toFiniteNumber(source.slotId)))
  );
  const unitIndex = toFiniteNumber(
    locator.unitIndex,
    toFiniteNumber(source.unitIndex, toFiniteNumber(source.boxId))
  );
  const boxId = toFiniteNumber(locator.boxId, toFiniteNumber(source.boxId));
  const slotIndex = toFiniteNumber(
    locator.slotIndex,
    toFiniteNumber(source.slotIndex, toFiniteNumber(source.slotId))
  );
  const protocolSlotId = toTrimmedString(
    locator.protocolSlotId ?? source.protocolSlotId ?? source.slotId
  ) || null;

  return {
    kind,
    index: slotLikeIndex,
    unitIndex,
    boxId,
    slotIndex,
    protocolSlotId,
  };
}

/**
 * observation sourceにREADY判定可能なlocator証拠があるか判定する。
 *
 * 【詳細説明】
 * - sourceIdや表示labelだけでは物理sourceの位置証拠として足りない。
 * - direct/externalはindex、CFS/CFS-CはunitIndexとslotIndexを必須にする。
 *
 * @private
 * @function hasCompleteObservedSourceLocator
 * @param {?Object} source - observed source snapshot。
 * @returns {boolean} locatorがcompleteならtrue。
 */
function hasCompleteObservedSourceLocator(source) {
  const locator = resolveObservedSourceLocatorInput(source);
  if (!locator) {
    return false;
  }
  const kind = resolveObservedSourceKind(source);
  if (kind === MATERIAL_SOURCE_KIND.DIRECT_FEED || kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL) {
    return locator.index !== null && locator.index !== undefined && Number.isFinite(Number(locator.index));
  }
  if (kind === MATERIAL_SOURCE_KIND.CFS_SLOT || kind === MATERIAL_SOURCE_KIND.CFS_C_SLOT) {
    return locator.unitIndex !== null &&
      locator.unitIndex !== undefined &&
      locator.slotIndex !== null &&
      locator.slotIndex !== undefined &&
      Number.isFinite(Number(locator.unitIndex)) &&
      Number.isFinite(Number(locator.slotIndex));
  }
  return false;
}

/**
 * legacyData内に対象deviceのopen Universal conflictがあるか判定する。
 *
 * 【詳細説明】
 * - Gate18.9Aでは実Universal storeはまだ無いが、dry-run journalやpure registry snapshotを
 *   呼び出し側が渡した場合に、既存conflictを無視して新規mount候補を出さないための境界。
 *
 * @private
 * @function hasOpenUniversalSourceConflict
 * @param {Object} legacyData - legacy monitorData。
 * @param {string} deviceId - device ID。
 * @returns {boolean} 未解決conflictがある場合true。
 */
function hasOpenUniversalSourceConflict(legacyData, deviceId) {
  const registry = legacyData?.materialAccounting?.materialSourceRegistry ||
    legacyData?.printerCoreV3MaterialSourceRegistry ||
    legacyData?.materialSourceRegistry;
  const conflicts = Array.isArray(registry?.conflicts) ? registry.conflicts : [];
  return conflicts.some((conflict) => {
    if (!conflict || typeof conflict !== "object") {
      return false;
    }
    const status = toTrimmedString(conflict.status || "open");
    const conflictDeviceId = toTrimmedString(conflict.deviceId);
    return status !== "resolved" && (!conflictDeviceId || conflictDeviceId === deviceId);
  });
}

/**
 * legacyData内に対象source/spoolのopen Universal SpoolMount conflictがあるか判定する。
 *
 * 【詳細説明】
 * - dry-run plannerはまだ本番repositoryを書かないが、既存repository snapshotが入力された場合、
 *   既にopenな同一source/spoolへ別mount候補を出してはならない。
 *
 * @private
 * @function hasOpenUniversalSpoolMountConflict
 * @param {Object} legacyData - legacy monitorData。
 * @param {Object} input - conflict判定入力。
 * @param {string} input.spoolId - managed spool ID。
 * @param {?string} input.materialSourceId - MaterialSource ID候補。
 * @returns {boolean} open mount conflictがある場合true。
 */
function hasOpenUniversalSpoolMountConflict(legacyData, input) {
  const repository = legacyData?.materialAccounting?.spoolMountRepository ||
    legacyData?.printerCoreV3SpoolMountRepository ||
    legacyData?.spoolMountRepository;
  const mounts = Array.isArray(repository?.mounts)
    ? repository.mounts
    : (Array.isArray(legacyData?.materialAccounting?.spoolMounts)
      ? legacyData.materialAccounting.spoolMounts
      : []);
  const spoolId = toTrimmedString(input.spoolId);
  const materialSourceId = toTrimmedString(input.materialSourceId);
  return mounts.some((mount) => {
    if (!mount || typeof mount !== "object") {
      return false;
    }
    if (toTrimmedString(mount.status || SPOOL_MOUNT_STATUS.OPEN) !== SPOOL_MOUNT_STATUS.OPEN) {
      return false;
    }
    return toTrimmedString(mount.spoolId) === spoolId ||
      (materialSourceId && toTrimmedString(mount.materialSourceId) === materialSourceId);
  });
}

/**
 * observed sourceからMaterialSource kindを解決する。
 *
 * @private
 * @function resolveObservedSourceKind
 * @param {?Object} source - observed source snapshot。
 * @returns {string} MaterialSource kind。
 */
function resolveObservedSourceKind(source) {
  if (source?.kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL || source?.type === "external") {
    return MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL;
  }
  if (source?.kind === MATERIAL_SOURCE_KIND.CFS_C_SLOT || source?.providerKind === "cfs-c") {
    return MATERIAL_SOURCE_KIND.CFS_C_SLOT;
  }
  if (source?.kind === MATERIAL_SOURCE_KIND.CFS_SLOT) {
    return MATERIAL_SOURCE_KIND.CFS_SLOT;
  }
  return MATERIAL_SOURCE_KIND.DIRECT_FEED;
}

/**
 * directまたはexternal source用のplanned recordsを生成する。
 *
 * @private
 * @function createSingleSourcePlannedRecords
 * @param {Object} input - 生成入力。
 * @param {string} input.deviceId - device ID。
 * @param {string} input.spoolId - managed spool ID。
 * @param {string} input.host - legacy host key。
 * @param {string} input.createdAt - migration作成時刻。
 * @param {?Object} input.observedSource - 単一source観測。
 * @returns {Object} plannedWrites object。
 */
function createSingleSourcePlannedRecords(input) {
  const observedSource = input.observedSource || null;
  const sourceKind = observedSource ? resolveObservedSourceKind(observedSource) : MATERIAL_SOURCE_KIND.DIRECT_FEED;
  const observedLocator = resolveObservedSourceLocatorInput(observedSource);
  const sourceLocator = observedLocator
    ? createMaterialSourceLocator(observedLocator)
    : createMaterialSourceLocator({ kind: sourceKind, index: 0 });
  const unit = createFilamentUnitRecord({
    deviceId: input.deviceId,
    kind: FILAMENT_UNIT_KIND.PRINTER_DIRECT,
    identity: createDirectFeedUnitIdentity({ deviceId: input.deviceId }),
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    providerId: observedSource?.providerId || "legacy-host-spool-map",
  });
  const source = createMaterialSourceRecord({
    deviceId: input.deviceId,
    unitId: unit.unitId,
    kind: sourceKind,
    locator: sourceLocator,
    identity: createMaterialSourceIdentity({
      deviceId: input.deviceId,
      unitId: unit.unitId,
      kind: sourceKind,
      slotIndex: sourceLocator.slotIndex,
      index: sourceLocator.index,
    }),
    identityStrength: MATERIAL_IDENTITY_STRENGTH.STABLE,
    displayLabel: observedSource?.displayLabel || (sourceKind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL ? "外部スプール" : "通常スプール"),
    aliases: observedSource?.sourceId ? [observedSource.sourceId] : [],
  });
  const mountCandidate = {
    materialSourceId: source.materialSourceId,
    spoolId: input.spoolId,
    verification: SPOOL_MOUNT_VERIFICATION.MIGRATED,
    sourceIdentityStrengthAtOpen: source.identityStrength,
    openedAtPolicy: "shadow-execution-time",
    operationIdPolicy: "shadow-execution-time",
    openedBy: "migration-shadow-executor",
  };
  return {
    filamentUnits: [unit],
    materialSources: [source],
    spoolMounts: [],
    mountCandidates: [deepFreezeJson(mountCandidate)],
  };
}

/**
 * plannedWritesの空shapeを生成する。
 *
 * @private
 * @function createEmptyPlannedWrites
 * @returns {Object} 空のplannedWrites。
 */
function createEmptyPlannedWrites() {
  return {
    filamentUnits: [],
    materialSources: [],
    spoolMounts: [],
    mountCandidates: [],
  };
}

/**
 * plannedWritesを安全に集計できる配列shapeへ正規化する。
 *
 * 【詳細説明】
 * - importされたjournal内の壊れたplanでもvalidatorがthrowしないよう、
 *   集計処理では存在しないfieldや非配列fieldを空配列として扱う。
 *
 * @private
 * @function getSafePlannedWrites
 * @param {?Object} entry - migration entry候補。
 * @returns {Object} 配列fieldだけを持つplannedWrites。
 */
function getSafePlannedWrites(entry) {
  const writes = entry?.plannedWrites && typeof entry.plannedWrites === "object"
    ? entry.plannedWrites
    : {};
  return {
    filamentUnits: Array.isArray(writes.filamentUnits) ? writes.filamentUnits : [],
    materialSources: Array.isArray(writes.materialSources) ? writes.materialSources : [],
    spoolMounts: Array.isArray(writes.spoolMounts) ? writes.spoolMounts : [],
    mountCandidates: Array.isArray(writes.mountCandidates) ? writes.mountCandidates : [],
  };
}

/**
 * 単一hostのlegacy spool割当をmigration分類する。
 *
 * @private
 * @function createHostMigrationEntry
 * @param {Object} input - entry生成入力。
 * @param {Object} input.legacyData - legacy monitorData。
 * @param {string} input.host - legacy host key。
 * @param {string} input.spoolId - spool ID。
 * @param {string} input.createdAt - migration作成時刻。
 * @param {number=} input.freshTtlMs - fresh扱いTTL。
 * @param {number=} input.allowedClockSkewMs - 未来観測の許容clock skew。
 * @param {Array<Object>=} input.confirmations - migration topology confirmation配列。
 * @param {string} input.migrationSubjectId - stable migration subject ID。
 * @param {string} input.confirmationEvidenceChecksum - confirmation前のdecision evidence checksum。
 * @param {string} input.confirmationRevisionId - confirmation前のdecision revision ID。
 * @returns {Object} migration entry。
 */
function createHostMigrationEntry(input) {
  const targets = getConnectionTargets(input.legacyData);
  const targetResolution = resolveConnectionTargetForHost(targets, input.host);
  const target = targetResolution.target;
  const machines = asPlainObject(input.legacyData?.machines);
  const machine = machines[input.host] || {};
  const deviceIdentity = targetResolution.deviceIdentity || resolveDeviceIdentityEvidence(input.host, target);
  const deviceId = deviceIdentity.deviceId;
  const observation = findObservationRecord(input.legacyData, input.host, deviceId);
  const observedSources = listObservedSources(observation);
  const hasFreshCompleteObservation = isFreshCompleteTopologyObservation(observation, {
    createdAt: input.createdAt,
    freshTtlMs: input.freshTtlMs,
    allowedClockSkewMs: input.allowedClockSkewMs,
  });
  const printerType = normalizePrinterType(target?.printerType || machine?.printerType);
  const isK2Like = printerType === "k2" || printerType.includes("k2");
  const hasSingleSpool = hasSingleSpoolConfiguration(target, machine);
  const isConfirmedSingleSpool = hasOperatorConfirmedSingleSpoolConfiguration({
    confirmations: input.confirmations || [],
    deviceId,
    host: input.host,
    migrationSubjectId: input.migrationSubjectId,
    confirmationEvidenceChecksum: input.confirmationEvidenceChecksum,
    confirmationRevisionId: input.confirmationRevisionId,
  });
  const createEntryResult = (details) => ({
    host: input.host,
    deviceId,
    spoolId: input.spoolId,
    migrationSubjectId: input.migrationSubjectId,
    confirmationEvidenceChecksum: input.confirmationEvidenceChecksum,
    confirmationRevisionId: input.confirmationRevisionId,
    ...details,
  });

  if (targetResolution.status === "ambiguous") {
    return createEntryResult({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_HOST_DEVICE_AMBIGUOUS],
      deviceCandidates: targetResolution.candidates,
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (targetResolution.hasOpenIdentityConflict) {
    return createEntryResult({
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_CONFLICT],
      deviceCandidates: targetResolution.candidates,
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (!hasLegacySpoolRecord(input.legacyData, input.spoolId)) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MISSING],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (deviceIdentity.identityStrength !== MATERIAL_IDENTITY_STRENGTH.STABLE) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.DEVICE_IDENTITY_INSUFFICIENT],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (hasOpenUniversalSourceConflict(input.legacyData, deviceId)) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_CONFLICT],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  const observationDeviceId = toTrimmedString(observation?.deviceId);
  if (observation && observationDeviceId && observationDeviceId !== deviceId) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_CONFLICT],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length > 0 && !hasFreshCompleteObservation) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length > 1) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_AMBIGUOUS_FOR_MULTI_SOURCE],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length === 1 && !isSingleDirectLikeSourceKind(observedSources[0].kind)) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_REQUIRES_SOURCE_CONFIRMATION],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length === 1 && !hasStableObservedSourceIdentity(observedSources[0])) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.SOURCE_IDENTITY_INSUFFICIENT],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length === 1 && !hasCompleteObservedSourceLocator(observedSources[0])) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_SOURCE_LOCATOR_INCOMPLETE],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length === 0 && isK2Like) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      candidateSources: [],
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length === 0 && !hasSingleSpool) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.MATERIAL_TOPOLOGY_OBSERVATION_REQUIRED],
      candidateSources: [],
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  if (observedSources.length === 0 && hasSingleSpool && !isConfirmedSingleSpool) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.LEGACY_SPOOL_MAP_REQUIRES_SOURCE_CONFIRMATION],
      candidateSources: [],
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  const plannedWrites = createSingleSourcePlannedRecords({
    deviceId,
    spoolId: input.spoolId,
    host: input.host,
    createdAt: input.createdAt,
    observedSource: observedSources[0] || null,
  });
  if (hasOpenUniversalSpoolMountConflict(input.legacyData, {
    spoolId: input.spoolId,
    materialSourceId: plannedWrites.materialSources[0]?.materialSourceId || null,
  })) {
    return createEntryResult({
      deviceCandidates: targetResolution.candidates,
      migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED,
      reasons: [MATERIAL_ACCOUNTING_MIGRATION_BLOCKER.OPEN_MOUNT_CONFLICT],
      candidateSources: observedSources,
      plannedWrites: createEmptyPlannedWrites(),
    });
  }

  return createEntryResult({
    deviceCandidates: targetResolution.candidates,
    migrationStatus: MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY,
    reasons: [],
    candidateSources: observedSources,
    plannedWrites,
  });
}

/**
 * plan全体のmigration statusを集約する。
 *
 * @private
 * @function summarizeMigrationStatus
 * @param {Array<Object>} entries - migration entry配列。
 * @returns {string} 集約migration status。
 */
function summarizeMigrationStatus(entries) {
  if (entries.some((entry) => entry?.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED)) {
    return MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED;
  }
  if (entries.some((entry) => entry?.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE)) {
    return MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE;
  }
  if (entries.some((entry) => entry?.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY)) {
    return MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY;
  }
  return MATERIAL_ACCOUNTING_MIGRATION_STATUS.PLANNED;
}

/**
 * migration entryを集計する。
 *
 * @private
 * @function summarizeEntries
 * @param {Array<Object>} entries - migration entry配列。
 * @returns {Object} 集計結果。
 */
function summarizeEntries(entries) {
  return entries.reduce((summary, entry) => {
    const plannedWrites = getSafePlannedWrites(entry);
    if (entry?.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY) {
      summary.ready += 1;
    } else if (entry?.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.CANDIDATE) {
      summary.candidate += 1;
    } else if (entry?.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.BLOCKED) {
      summary.blocked += 1;
    }
    summary.plannedWrites.filamentUnits += plannedWrites.filamentUnits.length;
    summary.plannedWrites.materialSources += plannedWrites.materialSources.length;
    summary.plannedWrites.spoolMounts += plannedWrites.spoolMounts.length;
    summary.plannedWrites.mountCandidates += plannedWrites.mountCandidates.length;
    return summary;
  }, {
    ready: 0,
    candidate: 0,
    blocked: 0,
    plannedWrites: {
      filamentUnits: 0,
      materialSources: 0,
      spoolMounts: 0,
      mountCandidates: 0,
    },
  });
}

/**
 * legacy hostSpoolMap から Universal MaterialSource migration dry-run planを生成する。
 *
 * 【詳細説明】
 * - この関数はmonitorData、IndexedDB、legacy hostSpoolMapを書き換えない。
 * - multi-source観測があるhostでは、legacy 1本スプールをどのsourceへ載せるかを自動決定しない。
 * - K2系でtopologyが未観測の場合もdirect-onlyとは仮定せず、再観測が必要なblocked entryとして返す。
 *
 * @function createMaterialAccountingMigrationDryRunPlan
 * @param {Object|null|undefined} legacyData - legacy monitorData互換データ。
 * @param {Object=} options - plan生成オプション。
 * @param {string=} options.createdAt - plan作成日時。
 * @param {number=} options.freshTtlMs - fresh扱いTTL。
 * @param {number=} options.allowedClockSkewMs - 未来観測の許容clock skew。
 * @returns {Object} dry-run migration plan。
 * @example
 * const plan = createMaterialAccountingMigrationDryRunPlan(monitorData, { createdAt: new Date().toISOString() });
 */
export function createMaterialAccountingMigrationDryRunPlan(legacyData, options = {}) {
  const source = legacyData && typeof legacyData === "object" ? legacyData : {};
  const createdAt = normalizeOptionalIsoTime(options.createdAt) || new Date().toISOString();
  const freshTtlMs = Math.max(1, Math.floor(toFiniteNumber(options.freshTtlMs, DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS) ?? DEFAULT_MIGRATION_TOPOLOGY_FRESH_TTL_MS));
  const allowedClockSkewMs = Math.max(0, Math.floor(toFiniteNumber(options.allowedClockSkewMs, DEFAULT_ALLOWED_CLOCK_SKEW_MS) ?? DEFAULT_ALLOWED_CLOCK_SKEW_MS));
  const hostSpoolMap = asPlainObject(source.hostSpoolMap);
  const migrationTopologyConfirmations = listMigrationTopologyConfirmations(source, options);
  const migrationBatchId = createMigrationBatchId(hostSpoolMap);
  const migrationSubjectId = migrationBatchId;
  const entryEvidenceBindings = Object.entries(hostSpoolMap)
    .filter(([host, spoolId]) => toTrimmedString(host) && toTrimmedString(spoolId))
    .map(([host, spoolId]) => ({
      host: toTrimmedString(host),
      spoolId: toTrimmedString(spoolId),
      ...createEntryConfirmationEvidenceBinding(source, {
        host: toTrimmedString(host),
        spoolId: toTrimmedString(spoolId),
        createdAt,
        freshTtlMs,
        allowedClockSkewMs,
      }),
    }));
  const acceptedMigrationTopologyConfirmationsBySubject = entryEvidenceBindings.reduce((accumulator, binding) => {
    accumulator[binding.migrationSubjectId] = listAcceptedMigrationTopologyConfirmationEvidence(
      migrationTopologyConfirmations,
      {
        migrationSubjectId: binding.migrationSubjectId,
        confirmationEvidenceChecksum: binding.confirmationEvidenceChecksum,
        confirmationRevisionId: binding.confirmationRevisionId,
      }
    );
    return accumulator;
  }, {});
  const acceptedMigrationTopologyConfirmations = Object.values(acceptedMigrationTopologyConfirmationsBySubject)
    .flat()
    .sort((a, b) => stableStringifyPrinterCoreV3Value(a).localeCompare(stableStringifyPrinterCoreV3Value(b)));
  const confirmationEvidenceChecksum = createMigrationSourceChecksum(createDecisionEvidenceProjection(source, {
    migrationSubjectId,
    createdAt,
    freshTtlMs,
    allowedClockSkewMs,
    acceptedMigrationTopologyConfirmations: [],
    hostSpoolMap,
  }));
  const confirmationRevisionId = createPrinterCoreV3DeterministicId(
    "material-accounting-confirmation-revision",
    [confirmationEvidenceChecksum]
  );
  const sourceChecksum = createMigrationSourceChecksum(createDecisionEvidenceProjection(source, {
    migrationSubjectId,
    createdAt,
    freshTtlMs,
    allowedClockSkewMs,
    confirmationEvidenceChecksum,
    confirmationRevisionId,
    acceptedMigrationTopologyConfirmations,
    hostSpoolMap,
  }));
  const planRevisionId = createPrinterCoreV3DeterministicId("material-accounting-plan-revision", [sourceChecksum]);
  const entries = entryEvidenceBindings
    .map((binding) => createHostMigrationEntry({
      legacyData: source,
      host: binding.host,
      spoolId: binding.spoolId,
      createdAt,
      freshTtlMs,
      allowedClockSkewMs,
      confirmations: acceptedMigrationTopologyConfirmationsBySubject[binding.migrationSubjectId] || [],
      migrationSubjectId: binding.migrationSubjectId,
      confirmationEvidenceChecksum: binding.confirmationEvidenceChecksum,
      confirmationRevisionId: binding.confirmationRevisionId,
    }));
  return deepFreezeJson({
    schemaVersion: MATERIAL_ACCOUNTING_MIGRATION_PLAN_SCHEMA_VERSION,
    status: "dry-run",
    migrationStatus: summarizeMigrationStatus(entries),
    migrationSubjectId,
    migrationBatchId,
    planRevisionId,
    migrationId: createPrinterCoreV3DeterministicId("material-accounting-migration", [planRevisionId]),
    createdAt,
    source: {
      schema: "legacy-monitorData-v2",
      checksum: sourceChecksum,
      migrationSubjectId,
      planRevisionId,
      confirmationEvidenceChecksum,
      confirmationRevisionId,
      acceptedMigrationTopologyConfirmationCount: acceptedMigrationTopologyConfirmations.length,
      plannerPolicyRevision: MATERIAL_ACCOUNTING_MIGRATION_PLANNER_POLICY_REVISION,
      freshTtlMs,
      allowedClockSkewMs,
    },
    entries,
    summary: summarizeEntries(entries),
    invariants: {
      activateUniversalWrites: false,
      preserveLegacyData: true,
      preserveHostSpoolMap: true,
      hostSpoolMapIsCompatibilityProjection: true,
      materialObservationIsReadOnly: true,
      migrationIsDryRunOnly: true,
    },
  });
}

/**
 * migration entryのplanned recordsを検証する。
 *
 * @private
 * @function validatePlannedWrites
 * @param {Object} entry - migration entry。
 * @returns {Array<string>} validation error一覧。
 */
function validatePlannedWrites(entry) {
  const errors = [];
  const rawWrites = entry?.plannedWrites;
  if (!rawWrites || typeof rawWrites !== "object") {
    errors.push("plannedWrites-not-object");
    return errors;
  }
  for (const writeName of ["filamentUnits", "materialSources", "spoolMounts", "mountCandidates"]) {
    if (!Array.isArray(rawWrites[writeName])) {
      errors.push(`plannedWrites-${writeName}-not-array`);
    }
  }
  const plannedWrites = getSafePlannedWrites(entry);
  const plannedFilamentUnitIds = new Set(
    plannedWrites.filamentUnits.map((unit) => toTrimmedString(unit?.unitId)).filter(Boolean)
  );
  const plannedMaterialSourceIds = new Set(
    plannedWrites.materialSources.map((source) => toTrimmedString(source?.materialSourceId)).filter(Boolean)
  );
  const entryDeviceId = toTrimmedString(entry?.deviceId);
  const entrySpoolId = toTrimmedString(entry?.spoolId);
  if (entry?.migrationStatus === MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY) {
    if (plannedWrites.filamentUnits.length !== 1) {
      errors.push("ready-entry-filamentUnit-count-invalid");
    }
    if (plannedWrites.materialSources.length !== 1) {
      errors.push("ready-entry-materialSource-count-invalid");
    }
    if (plannedWrites.spoolMounts.length !== 0) {
      errors.push("ready-entry-spoolMount-count-invalid");
    }
    if (plannedWrites.mountCandidates.length !== 1) {
      errors.push("ready-entry-mountCandidate-count-invalid");
    }
  }
  for (const unit of plannedWrites.filamentUnits) {
    const validation = validateFilamentUnit(unit);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => `filamentUnit:${error}`));
    }
    if (entryDeviceId && toTrimmedString(unit?.deviceId) && toTrimmedString(unit.deviceId) !== entryDeviceId) {
      errors.push("filamentUnit:deviceId-entry-mismatch");
    }
  }
  for (const source of plannedWrites.materialSources) {
    const validation = validateMaterialSource(source);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => `materialSource:${error}`));
    }
    if (entryDeviceId && toTrimmedString(source?.deviceId) && toTrimmedString(source.deviceId) !== entryDeviceId) {
      errors.push("materialSource:deviceId-entry-mismatch");
    }
    if (toTrimmedString(source?.unitId) && !plannedFilamentUnitIds.has(toTrimmedString(source.unitId))) {
      errors.push("materialSource:unitId-not-planned");
    }
  }
  for (const mount of plannedWrites.spoolMounts) {
    const validation = validateSpoolMount(mount);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => `spoolMount:${error}`));
    }
  }
  for (const candidate of plannedWrites.mountCandidates) {
    if (!candidate || typeof candidate !== "object") {
      errors.push("mountCandidate:not-object");
      continue;
    }
    if (!toTrimmedString(candidate.materialSourceId)) {
      errors.push("mountCandidate:materialSourceId-required");
    }
    if (!toTrimmedString(candidate.spoolId)) {
      errors.push("mountCandidate:spoolId-required");
    }
    if (entrySpoolId && toTrimmedString(candidate.spoolId) && toTrimmedString(candidate.spoolId) !== entrySpoolId) {
      errors.push("mountCandidate:spoolId-entry-mismatch");
    }
    if (toTrimmedString(candidate.materialSourceId) && !plannedMaterialSourceIds.has(toTrimmedString(candidate.materialSourceId))) {
      errors.push("mountCandidate:materialSourceId-not-planned");
    }
    if (candidate.openedAt !== undefined || candidate.mountOperationId !== undefined) {
      errors.push("mountCandidate:execution-fields-forbidden");
    }
    if (candidate.openedAtPolicy !== "shadow-execution-time" ||
        candidate.operationIdPolicy !== "shadow-execution-time") {
      errors.push("mountCandidate:execution-policy-required");
    }
  }
  return errors;
}

/**
 * Universal MaterialSource migration dry-run planを検証する。
 *
 * 【詳細説明】
 * - planがdry-runであり、production writeを有効化しないことを確認する。
 * - READY entryについてはplanned MaterialSource/SpoolMount/Cutoverの契約検証も行う。
 *
 * @function validateMaterialAccountingMigrationDryRunPlan
 * @param {Object|null|undefined} plan - migration dry-run plan。
 * @returns {{ok:boolean, errors:string[]}} validation結果。
 * @example
 * const validation = validateMaterialAccountingMigrationDryRunPlan(plan);
 */
export function validateMaterialAccountingMigrationDryRunPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan-not-object"] };
  }
  if (plan.schemaVersion !== MATERIAL_ACCOUNTING_MIGRATION_PLAN_SCHEMA_VERSION) {
    errors.push("unexpected-plan-schema-version");
  }
  if (plan.status !== "dry-run") {
    errors.push("plan-status-not-dry-run");
  }
  if (!enumValues(MATERIAL_ACCOUNTING_MIGRATION_STATUS).has(plan.migrationStatus)) {
    errors.push("invalid-migrationStatus");
  } else if (!DRY_RUN_DECISION_STATUSES.has(plan.migrationStatus)) {
    errors.push("plan-status-not-dry-run-decision");
  }
  if (plan.invariants?.activateUniversalWrites !== false) {
    errors.push("plan-activates-universal-writes");
  }
  if (plan.invariants?.preserveHostSpoolMap !== true) {
    errors.push("plan-does-not-preserve-hostSpoolMap");
  }
  const sourceChecksum = toTrimmedString(plan.source?.checksum);
  const migrationSubjectId = toTrimmedString(plan.migrationSubjectId);
  const planRevisionId = toTrimmedString(plan.planRevisionId);
  if (!migrationSubjectId) {
    errors.push("migrationSubjectId-required");
  }
  if (!planRevisionId) {
    errors.push("planRevisionId-required");
  }
  if (toTrimmedString(plan.source?.migrationSubjectId) !== migrationSubjectId) {
    errors.push("source-migrationSubjectId-plan-mismatch");
  }
  if (toTrimmedString(plan.source?.planRevisionId) !== planRevisionId) {
    errors.push("source-planRevisionId-plan-mismatch");
  }
  if (sourceChecksum && planRevisionId &&
      createPrinterCoreV3DeterministicId("material-accounting-plan-revision", [sourceChecksum]) !== planRevisionId) {
    errors.push("planRevisionId-sourceChecksum-mismatch");
  }
  if (planRevisionId && toTrimmedString(plan.migrationId) &&
      createPrinterCoreV3DeterministicId("material-accounting-migration", [planRevisionId]) !== toTrimmedString(plan.migrationId)) {
    errors.push("migrationId-planRevisionId-mismatch");
  }
  if (!Array.isArray(plan.entries)) {
    errors.push("entries-not-array");
  } else {
    const expectedStatus = summarizeMigrationStatus(plan.entries);
    const expectedSummary = summarizeEntries(plan.entries);
    if (plan.migrationStatus !== expectedStatus) {
      errors.push("migrationStatus-summary-mismatch");
    }
    for (const countName of ["ready", "candidate", "blocked"]) {
      if (plan.summary?.[countName] !== expectedSummary[countName]) {
        errors.push(`summary-${countName}-count-mismatch`);
      }
    }
    for (const writeName of ["filamentUnits", "materialSources", "spoolMounts", "mountCandidates"]) {
      if (plan.summary?.plannedWrites?.[writeName] !== expectedSummary.plannedWrites[writeName]) {
        errors.push(`summary-${writeName}-write-count-mismatch`);
      }
    }
    for (const entry of plan.entries) {
      if (!enumValues(MATERIAL_ACCOUNTING_MIGRATION_STATUS).has(entry?.migrationStatus)) {
        errors.push("entry-invalid-migrationStatus");
      } else if (!DRY_RUN_DECISION_STATUSES.has(entry.migrationStatus)) {
        errors.push("entry-status-not-dry-run-decision");
      }
      if (entry?.migrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY &&
          (entry?.plannedWrites?.filamentUnits || []).length > 0) {
        errors.push("non-ready-entry-has-filamentUnit-write");
      }
      if (entry?.migrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY &&
          (entry?.plannedWrites?.materialSources || []).length > 0) {
        errors.push("non-ready-entry-has-materialSource-write");
      }
      if (entry?.migrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY &&
          (entry?.plannedWrites?.spoolMounts || []).length > 0) {
        errors.push("non-ready-entry-has-spoolMount-write");
      }
      if (entry?.migrationStatus !== MATERIAL_ACCOUNTING_MIGRATION_STATUS.READY &&
          (entry?.plannedWrites?.mountCandidates || []).length > 0) {
        errors.push("non-ready-entry-has-mountCandidate-write");
      }
      errors.push(...validatePlannedWrites(entry));
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}
