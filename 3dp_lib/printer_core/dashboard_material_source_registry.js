/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource registry モジュール
 * @file dashboard_material_source_registry.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_source_registry
 *
 * 【機能内容サマリ】
 * - Gate 18.9A の MaterialSource をDevice単位で管理するpure in-memory registryを提供
 * - 物理locatorとsource identityを分離し、K1 direct/N=1とK2 CFS/N>1を同一APIで扱う
 * - locator/identity衝突を自動上書きせず、rekey/conflict候補として返す
 *
 * 【公開関数一覧】
 * - {@link createMaterialSourceRegistry}：MaterialSource registryを生成
 * - {@link createMaterialSourceLocatorKey}：Device内locator keyを生成
 * - {@link createMaterialSourceIdentityKey}：Device内identity keyを生成
 *
 * @version 1.390.1500 (PR #438)
 * @since   1.390.1496 (PR #438)
 * @lastModified 2026-08-31 12:00:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9A 後続でIndexedDB backed repositoryへ同じcontractを接続する
 */

"use strict";

import {
  MATERIAL_SOURCE_KIND,
  MATERIAL_IDENTITY_STRENGTH,
  createMaterialSourceLocator,
  validateMaterialSource,
} from "./dashboard_material_accounting_contract.js";

/**
 * JSON互換値をcloneする。
 *
 * 【詳細説明】
 * - registry内部recordを呼び出し側mutationから守るため、保存時/返却時にcloneする。
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
 * JSON objectのkey順を安定化してstringifyする。
 *
 * 【詳細説明】
 * - locator/identityはprotocol由来でkey順が揺れる可能性があるため、registry keyでは再帰的にkeyをsortする。
 *
 * @private
 * @function stableStringify
 * @param {*} value - stringify対象。
 * @returns {string} 安定化されたJSON文字列。
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * freeze済みcloneを生成する。
 *
 * @private
 * @function freezeClone
 * @param {*} value - freeze対象。
 * @returns {*} freeze済みclone。
 */
function freezeClone(value) {
  const cloned = cloneJsonValue(value);
  if (cloned && typeof cloned === "object") {
    return Object.freeze(cloned);
  }
  return cloned;
}

/**
 * MaterialSource registry resultを生成する。
 *
 * @private
 * @function createRegistryResult
 * @param {Object} input - result入力。
 * @param {boolean} input.ok - 成功可否。
 * @param {string} input.action - registry action。
 * @param {Object|null} [input.record=null] - 対象record。
 * @param {Array<Object>} [input.conflicts=[]] - conflict/rekey候補。
 * @param {Array<string>} [input.errors=[]] - validation error。
 * @returns {Object} registry result。
 */
function createRegistryResult({
  ok,
  action,
  record = null,
  conflicts = [],
  errors = [],
}) {
  return Object.freeze({
    ok,
    action,
    record: record ? freezeClone(record) : null,
    conflicts: Object.freeze(conflicts.map((conflict) => freezeClone(conflict))),
    errors: Object.freeze([...errors]),
  });
}

/**
 * locator/identity競合recordを生成する。
 *
 * @private
 * @function createConflictRecord
 * @param {Object} input - conflict入力。
 * @param {string} input.type - conflict種別。
 * @param {string} input.reason - conflict理由。
 * @param {Object} input.existingSource - 既存source。
 * @param {Object} input.candidateSource - 候補source。
 * @param {string} input.key - 衝突key。
 * @returns {Object} conflict record。
 */
function createConflictRecord({
  type,
  reason,
  existingSource,
  candidateSource,
  key,
}) {
  return Object.freeze({
    type,
    reason,
    key,
    existingMaterialSourceId: existingSource.materialSourceId,
    candidateMaterialSourceId: candidateSource.materialSourceId,
    deviceId: candidateSource.deviceId,
  });
}

/**
 * MaterialSource locatorをcanonical shapeへ正規化する。
 *
 * 【詳細説明】
 * - 永続化済みrecordや手動生成recordでは、factory由来の`null`フィールドが欠ける場合がある。
 * - locator keyは物理source同一性を判断するため、同じ意味のlocatorは同じshapeへ揃えてからkey化する。
 *
 * @private
 * @function canonicalizeMaterialSourceLocator
 * @param {Object} locator - MaterialSource locator。
 * @returns {Object} canonical locator。
 * @throws {TypeError} locatorが不正な場合。
 */
function canonicalizeMaterialSourceLocator(locator) {
  return createMaterialSourceLocator({
    kind: locator?.kind,
    index: locator?.index,
    unitIndex: locator?.unitIndex,
    boxId: locator?.boxId,
    slotIndex: locator?.slotIndex,
    protocolSlotId: locator?.protocolSlotId,
  });
}

/**
 * registry固有のMaterialSource validation errorを取得する。
 *
 * 【詳細説明】
 * - contract validationより一段強く、registry index生成時に例外へ落ちるrecordを事前にinvalidとして返す。
 * - stable sourceはidentity indexへ入るため、identity objectを必須にする。
 *
 * @private
 * @function getRegistrySourceErrors
 * @param {Object} source - MaterialSource record。
 * @returns {Array<string>} registry validation error。
 */
function getRegistrySourceErrors(source) {
  const errors = [];
  let canonicalLocator = null;
  try {
    canonicalLocator = canonicalizeMaterialSourceLocator(source?.locator);
  } catch (error) {
    errors.push("invalid-locator");
  }
  if (source?.identity && typeof source.identity === "object") {
    if (source.identity.namespace !== "material-source" || !Array.isArray(source.identity.parts)) {
      errors.push("invalid-identity");
    } else {
      if (source.identity.parts[0] !== source.deviceId) {
        errors.push("identity-device-mismatch");
      }
      if (source.identity.parts[1] !== source.unitId) {
        errors.push("identity-unit-mismatch");
      }
      if (source.identity.parts[2] !== source.kind) {
        errors.push("identity-kind-mismatch");
      }
      if (
        (source.kind === MATERIAL_SOURCE_KIND.CFS_SLOT ||
          source.kind === MATERIAL_SOURCE_KIND.CFS_C_SLOT) &&
        canonicalLocator &&
        (source.identity.parts[3] ?? null) !== (canonicalLocator.slotIndex ?? null)
      ) {
        errors.push("identity-locator-slot-mismatch");
      }
      if (
        (source.kind === MATERIAL_SOURCE_KIND.DIRECT_FEED ||
          source.kind === MATERIAL_SOURCE_KIND.EXTERNAL_SPOOL) &&
        canonicalLocator &&
        (source.identity.parts[4] ?? null) !== (canonicalLocator.index ?? null)
      ) {
        errors.push("identity-locator-index-mismatch");
      }
    }
  }
  if (
    source?.identityStrength === MATERIAL_IDENTITY_STRENGTH.STABLE &&
    (!source.identity || typeof source.identity !== "object")
  ) {
    errors.push("missing-identity");
  }
  return errors;
}

/**
 * Device内MaterialSource locator keyを生成する。
 *
 * 【詳細説明】
 * - `1A`などの表示labelではなく、normalized locator objectからkeyを作る。
 * - このkeyは物理/protocol位置の解決用であり、stable source identityとは別物として扱う。
 *
 * @function createMaterialSourceLocatorKey
 * @param {string} deviceId - Device ID。
 * @param {Object} locator - MaterialSource locator。
 * @returns {string} registry locator key。
 * @throws {TypeError} deviceIdまたはlocatorが不足した場合。
 * @example
 * const key = createMaterialSourceLocatorKey("serial:k2", { kind: "cfs-slot", unitIndex: 1, slotIndex: 0 });
 */
export function createMaterialSourceLocatorKey(deviceId, locator) {
  if (!deviceId || typeof deviceId !== "string") {
    throw new TypeError("deviceId is required");
  }
  if (!locator || typeof locator !== "object") {
    throw new TypeError("locator is required");
  }
  return `locator:${deviceId}:${stableStringify(canonicalizeMaterialSourceLocator(locator))}`;
}

/**
 * Device内MaterialSource identity keyを生成する。
 *
 * 【詳細説明】
 * - identity namespace/partsをkey化し、locator変更やdisplay label変更とsource identityを混同しない。
 *
 * @function createMaterialSourceIdentityKey
 * @param {string} deviceId - Device ID。
 * @param {Object} identity - MaterialSource identity。
 * @returns {string} registry identity key。
 * @throws {TypeError} deviceIdまたはidentityが不足した場合。
 * @example
 * const key = createMaterialSourceIdentityKey("serial:k2", { namespace: "material-source", parts: ["serial:k2", "slot"] });
 */
export function createMaterialSourceIdentityKey(deviceId, identity) {
  if (!deviceId || typeof deviceId !== "string") {
    throw new TypeError("deviceId is required");
  }
  if (!identity || typeof identity !== "object") {
    throw new TypeError("identity is required");
  }
  return `identity:${deviceId}:${stableStringify(identity)}`;
}

/**
 * MaterialSourceをDevice単位で管理するpure registryを生成する。
 *
 * 【詳細説明】
 * - このregistryはGate18.9Aのpure層であり、localStorage/IndexedDB/UIへ副作用を書かない。
 * - locator衝突やstable identity衝突は自動統合せず、callerがrekey/correction判断を行うためのresultとして返す。
 * - 同一materialSourceIdの再登録は既存recordを更新するが、別IDが同じlocatorやstable identityを名乗る場合は拒否する。
 *
 * @function createMaterialSourceRegistry
 * @param {Array<Object>} [initialSources=[]] - 初期MaterialSource配列。
 * @returns {Object} registry API。
 * @throws {Error} 初期sourceにinvalid recordが含まれる場合。
 * @example
 * const registry = createMaterialSourceRegistry();
 * const result = registry.upsertSource(source);
 */
export function createMaterialSourceRegistry(initialSources = []) {
  const sourcesById = new Map();
  const sourceIdsByDevice = new Map();
  const sourceIdByLocatorKey = new Map();
  const sourceIdByIdentityKey = new Map();
  const conflicts = [];

  /**
   * sourceをregistry indexから外す。
   *
   * @private
   * @function deindexSource
   * @param {Object} source - index解除対象source。
   * @returns {void}
   */
  function deindexSource(source) {
    const ids = sourceIdsByDevice.get(source.deviceId);
    if (ids) {
      ids.delete(source.materialSourceId);
      if (ids.size === 0) {
        sourceIdsByDevice.delete(source.deviceId);
      }
    }

    sourceIdByLocatorKey.delete(createMaterialSourceLocatorKey(source.deviceId, source.locator));

    if (source.identityStrength === MATERIAL_IDENTITY_STRENGTH.STABLE) {
      sourceIdByIdentityKey.delete(createMaterialSourceIdentityKey(source.deviceId, source.identity));
    }
  }

  /**
   * sourceをregistryへ保存する内部処理。
   *
   * @private
   * @function storeSource
   * @param {Object} source - 保存するMaterialSource。
   * @returns {Object} 保存済みsource。
   */
  function storeSource(source) {
    const previous = sourcesById.get(source.materialSourceId);
    if (previous) {
      deindexSource(previous);
    }

    const stored = freezeClone(source);
    sourcesById.set(stored.materialSourceId, stored);

    if (!sourceIdsByDevice.has(stored.deviceId)) {
      sourceIdsByDevice.set(stored.deviceId, new Set());
    }
    sourceIdsByDevice.get(stored.deviceId).add(stored.materialSourceId);

    sourceIdByLocatorKey.set(
      createMaterialSourceLocatorKey(stored.deviceId, stored.locator),
      stored.materialSourceId,
    );

    if (stored.identityStrength === MATERIAL_IDENTITY_STRENGTH.STABLE) {
      sourceIdByIdentityKey.set(
        createMaterialSourceIdentityKey(stored.deviceId, stored.identity),
        stored.materialSourceId,
      );
    }

    return stored;
  }

  /**
   * sourceをregistryへ追加または更新する。
   *
   * @function upsertSource
   * @param {Object} source - MaterialSource record。
   * @returns {Object} registry result。
   */
  function upsertSource(source) {
    const validation = validateMaterialSource(source);
    if (!validation.ok) {
      return createRegistryResult({
        ok: false,
        action: "invalid",
        errors: validation.errors,
      });
    }
    const existingById = sourcesById.get(source.materialSourceId);
    const registryErrors = getRegistrySourceErrors(source);
    if (registryErrors.includes("invalid-locator")) {
      return createRegistryResult({
        ok: false,
        action: "invalid",
        errors: registryErrors,
      });
    }

    const locatorKey = createMaterialSourceLocatorKey(source.deviceId, source.locator);
    const existingLocatorId = sourceIdByLocatorKey.get(locatorKey);
    const conflictRecords = [];

    if (existingById && existingById.deviceId !== source.deviceId) {
      conflictRecords.push(createConflictRecord({
        type: "source-id-immutability-conflict",
        reason: "material-source-id-device-changed",
        existingSource: existingById,
        candidateSource: source,
        key: source.materialSourceId,
      }));
    }

    if (
      existingById &&
      stableStringify(existingById.identity) !== stableStringify(source.identity)
    ) {
      conflictRecords.push(createConflictRecord({
        type: "source-id-immutability-conflict",
        reason: "material-source-id-identity-changed",
        existingSource: existingById,
        candidateSource: source,
        key: source.materialSourceId,
      }));
    }

    if (existingById && existingById.unitId !== source.unitId) {
      conflictRecords.push(createConflictRecord({
        type: "source-id-immutability-conflict",
        reason: "material-source-id-unit-changed",
        existingSource: existingById,
        candidateSource: source,
        key: source.materialSourceId,
      }));
    }

    if (existingById && existingById.kind !== source.kind) {
      conflictRecords.push(createConflictRecord({
        type: "source-id-immutability-conflict",
        reason: "material-source-id-kind-changed",
        existingSource: existingById,
        candidateSource: source,
        key: source.materialSourceId,
      }));
    }

    if (existingById && existingById.identityStrength !== source.identityStrength) {
      conflictRecords.push(createConflictRecord({
        type: "source-id-immutability-conflict",
        reason: "material-source-id-identity-strength-changed",
        existingSource: existingById,
        candidateSource: source,
        key: source.materialSourceId,
      }));
    }

    if (
      existingById &&
      existingById.identityStrength !== MATERIAL_IDENTITY_STRENGTH.STABLE &&
      createMaterialSourceLocatorKey(existingById.deviceId, existingById.locator) !== locatorKey
    ) {
      conflictRecords.push(createConflictRecord({
        type: "source-id-rekey-required",
        reason: "provisional-source-locator-changed",
        existingSource: existingById,
        candidateSource: source,
        key: source.materialSourceId,
      }));
    }

    if (existingLocatorId && existingLocatorId !== source.materialSourceId) {
      conflictRecords.push(createConflictRecord({
        type: "locator-conflict",
        reason: "same-device-locator-different-source",
        existingSource: sourcesById.get(existingLocatorId),
        candidateSource: source,
        key: locatorKey,
      }));
    }

    if (conflictRecords.length > 0) {
      conflicts.push(...conflictRecords);
      return createRegistryResult({
        ok: false,
        action: "conflict",
        record: existingById || null,
        conflicts: conflictRecords,
      });
    }

    if (registryErrors.length > 0) {
      return createRegistryResult({
        ok: false,
        action: "invalid",
        errors: registryErrors,
      });
    }

    if (source.identityStrength === MATERIAL_IDENTITY_STRENGTH.STABLE) {
      const identityKey = createMaterialSourceIdentityKey(source.deviceId, source.identity);
      const existingIdentityId = sourceIdByIdentityKey.get(identityKey);
      if (existingIdentityId && existingIdentityId !== source.materialSourceId) {
        conflictRecords.push(createConflictRecord({
          type: "identity-conflict",
          reason: "same-stable-identity-different-source",
          existingSource: sourcesById.get(existingIdentityId),
          candidateSource: source,
          key: identityKey,
        }));
      }
    }

    if (conflictRecords.length > 0) {
      conflicts.push(...conflictRecords);
      return createRegistryResult({
        ok: false,
        action: "conflict",
        record: existingById || null,
        conflicts: conflictRecords,
      });
    }

    const stored = storeSource(source);
    return createRegistryResult({
      ok: true,
      action: existingById ? "update" : "insert",
      record: stored,
    });
  }

  /**
   * materialSourceIdからsourceを取得する。
   *
   * @function getSource
   * @param {string} materialSourceId - MaterialSource ID。
   * @returns {Object|null} source record。
   */
  function getSource(materialSourceId) {
    const source = sourcesById.get(materialSourceId);
    return source ? freezeClone(source) : null;
  }

  /**
   * Device配下のsource一覧を取得する。
   *
   * @function listDeviceSources
   * @param {string} deviceId - Device ID。
   * @returns {Array<Object>} source record配列。
   */
  function listDeviceSources(deviceId) {
    const ids = sourceIdsByDevice.get(deviceId);
    if (!ids) {
      return [];
    }
    return [...ids].map((id) => freezeClone(sourcesById.get(id)));
  }

  /**
   * Device内locatorからsourceを解決する。
   *
   * @function resolveByLocator
   * @param {string} deviceId - Device ID。
   * @param {Object} locator - MaterialSource locator。
   * @returns {Object|null} source record。
   */
  function resolveByLocator(deviceId, locator) {
    const id = sourceIdByLocatorKey.get(createMaterialSourceLocatorKey(deviceId, locator));
    return id ? getSource(id) : null;
  }

  /**
   * Device内stable identityからsourceを解決する。
   *
   * @function resolveByIdentity
   * @param {string} deviceId - Device ID。
   * @param {Object} identity - MaterialSource identity。
   * @returns {Object|null} source record。
   */
  function resolveByIdentity(deviceId, identity) {
    const id = sourceIdByIdentityKey.get(createMaterialSourceIdentityKey(deviceId, identity));
    return id ? getSource(id) : null;
  }

  /**
   * registryが保持するconflict一覧を取得する。
   *
   * @function getConflicts
   * @returns {Array<Object>} conflict record配列。
   */
  function getConflicts() {
    return conflicts.map((conflict) => freezeClone(conflict));
  }

  /**
   * registryのJSON snapshotを取得する。
   *
   * @function toJSON
   * @returns {Object} registry snapshot。
   */
  function toJSON() {
    return Object.freeze({
      sources: Object.freeze([...sourcesById.values()].map((source) => freezeClone(source))),
      conflicts: Object.freeze(getConflicts()),
    });
  }

  for (const source of initialSources) {
    const result = upsertSource(source);
    if (!result.ok) {
      throw new Error(`invalid initial material source registry input: ${result.errors.concat(result.conflicts.map((conflict) => conflict.reason)).join(",")}`);
    }
  }

  return Object.freeze({
    upsertSource,
    getSource,
    listDeviceSources,
    resolveByLocator,
    resolveByIdentity,
    getConflicts,
    toJSON,
  });
}
