/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal SpoolMount repository モジュール
 * @file dashboard_spool_mount_repository.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_spool_mount_repository
 *
 * 【機能内容サマリ】
 * - Gate 18.9A の SpoolMount を管理するpure in-memory repositoryを提供
 * - MaterialSource単位とSpool単位のopen mount最大1制約を固定
 * - mountOperationIdの冪等性とpayload差異conflictを永続化前に固定
 *
 * 【公開関数一覧】
 * - {@link createSpoolMountRepository}：SpoolMount repositoryを生成
 *
 * @version 1.390.1496 (PR #438)
 * @since   1.390.1496 (PR #438)
 * @lastModified 2026-08-31 10:37:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9A 後続でIndexedDB backed repositoryへ同じcontractを接続する
 */

"use strict";

import {
  SPOOL_MOUNT_STATUS,
  validateSpoolMount,
} from "./dashboard_material_accounting_contract.js";

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
 * JSON objectのkey順を安定化してstringifyする。
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
 * repository resultを生成する。
 *
 * @private
 * @function createRepositoryResult
 * @param {Object} input - result入力。
 * @param {boolean} input.ok - 成功可否。
 * @param {string} input.action - repository action。
 * @param {Object|null} [input.record=null] - 対象record。
 * @param {Array<Object>} [input.conflicts=[]] - conflict配列。
 * @param {Array<string>} [input.errors=[]] - validation error配列。
 * @returns {Object} repository result。
 */
function createRepositoryResult({
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
 * SpoolMount conflict recordを生成する。
 *
 * @private
 * @function createMountConflict
 * @param {Object} input - conflict入力。
 * @param {string} input.type - conflict種別。
 * @param {string} input.reason - conflict理由。
 * @param {Object} input.existingMount - 既存mount。
 * @param {Object} input.candidateMount - 候補mount。
 * @returns {Object} conflict record。
 */
function createMountConflict({
  type,
  reason,
  existingMount,
  candidateMount,
}) {
  return Object.freeze({
    type,
    reason,
    existingMountId: existingMount.mountId,
    candidateMountId: candidateMount.mountId,
    materialSourceId: candidateMount.materialSourceId,
    spoolId: candidateMount.spoolId,
    mountOperationId: candidateMount.mountOperationId,
  });
}

/**
 * mount payloadが同一か判定する。
 *
 * @private
 * @function isSameMountPayload
 * @param {Object} left - 左辺mount。
 * @param {Object} right - 右辺mount。
 * @returns {boolean} 同一payloadならtrue。
 */
function isSameMountPayload(left, right) {
  return stableStringify(left) === stableStringify(right);
}

/**
 * SpoolMount repositoryを生成する。
 *
 * 【詳細説明】
 * - このrepositoryはGate18.9Aのpure層であり、IndexedDB/localStorage/UIへの副作用を持たない。
 * - 1つのMaterialSourceへ同時にopenできるSpoolMountは1件だけ。
 * - 1つのSpoolは全Device横断で同時にopenできるSpoolMountを1件だけ持てる。
 * - 同じmountOperationIdの再送はpayload同一なら冪等成功、payload差異ならconflictとして拒否する。
 *
 * @function createSpoolMountRepository
 * @param {Array<Object>} [initialMounts=[]] - 初期SpoolMount配列。
 * @returns {Object} repository API。
 * @throws {Error} 初期mountにinvalid/conflictが含まれる場合。
 * @example
 * const repository = createSpoolMountRepository();
 * const result = repository.recordMount(mount);
 */
export function createSpoolMountRepository(initialMounts = []) {
  const mountsById = new Map();
  const mountIdsBySource = new Map();
  const mountIdsBySpool = new Map();
  const openMountIdBySource = new Map();
  const openMountIdBySpool = new Map();
  const mountIdByOperationId = new Map();
  const conflicts = [];

  /**
   * mountをindexへ追加する。
   *
   * @private
   * @function indexMount
   * @param {Object} mount - index対象mount。
   * @returns {void}
   */
  function indexMount(mount) {
    if (!mountIdsBySource.has(mount.materialSourceId)) {
      mountIdsBySource.set(mount.materialSourceId, new Set());
    }
    mountIdsBySource.get(mount.materialSourceId).add(mount.mountId);

    if (!mountIdsBySpool.has(mount.spoolId)) {
      mountIdsBySpool.set(mount.spoolId, new Set());
    }
    mountIdsBySpool.get(mount.spoolId).add(mount.mountId);

    mountIdByOperationId.set(mount.mountOperationId, mount.mountId);

    if (mount.status === SPOOL_MOUNT_STATUS.OPEN) {
      openMountIdBySource.set(mount.materialSourceId, mount.mountId);
      openMountIdBySpool.set(mount.spoolId, mount.mountId);
    }
  }

  /**
   * mountをrepositoryへ記録する。
   *
   * @function recordMount
   * @param {Object} mount - SpoolMount record。
   * @returns {Object} repository result。
   */
  function recordMount(mount) {
    const validation = validateSpoolMount(mount);
    if (!validation.ok) {
      return createRepositoryResult({
        ok: false,
        action: "invalid",
        errors: validation.errors,
      });
    }

    const existingOperationMountId = mountIdByOperationId.get(mount.mountOperationId);
    if (existingOperationMountId) {
      const existingOperationMount = mountsById.get(existingOperationMountId);
      if (isSameMountPayload(existingOperationMount, mount)) {
        return createRepositoryResult({
          ok: true,
          action: "idempotent",
          record: existingOperationMount,
        });
      }
      const conflict = createMountConflict({
        type: "operation-payload-conflict",
        reason: "same-mount-operation-different-payload",
        existingMount: existingOperationMount,
        candidateMount: mount,
      });
      conflicts.push(conflict);
      return createRepositoryResult({
        ok: false,
        action: "conflict",
        conflicts: [conflict],
      });
    }

    const existingById = mountsById.get(mount.mountId);
    if (existingById && !isSameMountPayload(existingById, mount)) {
      const conflict = createMountConflict({
        type: "mount-id-payload-conflict",
        reason: "same-mount-id-different-payload",
        existingMount: existingById,
        candidateMount: mount,
      });
      conflicts.push(conflict);
      return createRepositoryResult({
        ok: false,
        action: "conflict",
        record: existingById,
        conflicts: [conflict],
      });
    }

    if (mount.status === SPOOL_MOUNT_STATUS.OPEN) {
      const existingSourceOpenId = openMountIdBySource.get(mount.materialSourceId);
      if (existingSourceOpenId && existingSourceOpenId !== mount.mountId) {
        const conflict = createMountConflict({
          type: "source-open-mount-conflict",
          reason: "material-source-already-has-open-mount",
          existingMount: mountsById.get(existingSourceOpenId),
          candidateMount: mount,
        });
        conflicts.push(conflict);
        return createRepositoryResult({
          ok: false,
          action: "conflict",
          conflicts: [conflict],
        });
      }

      const existingSpoolOpenId = openMountIdBySpool.get(mount.spoolId);
      if (existingSpoolOpenId && existingSpoolOpenId !== mount.mountId) {
        const conflict = createMountConflict({
          type: "spool-open-mount-conflict",
          reason: "spool-already-mounted-on-another-source",
          existingMount: mountsById.get(existingSpoolOpenId),
          candidateMount: mount,
        });
        conflicts.push(conflict);
        return createRepositoryResult({
          ok: false,
          action: "conflict",
          conflicts: [conflict],
        });
      }
    }

    const stored = freezeClone(mount);
    mountsById.set(stored.mountId, stored);
    indexMount(stored);

    return createRepositoryResult({
      ok: true,
      action: existingById ? "idempotent" : "insert",
      record: stored,
    });
  }

  /**
   * mountIdからSpoolMountを取得する。
   *
   * @function getMount
   * @param {string} mountId - SpoolMount ID。
   * @returns {Object|null} SpoolMount record。
   */
  function getMount(mountId) {
    const mount = mountsById.get(mountId);
    return mount ? freezeClone(mount) : null;
  }

  /**
   * MaterialSource配下のmount一覧を取得する。
   *
   * @function listMountsForSource
   * @param {string} materialSourceId - MaterialSource ID。
   * @returns {Array<Object>} SpoolMount record配列。
   */
  function listMountsForSource(materialSourceId) {
    const ids = mountIdsBySource.get(materialSourceId);
    if (!ids) {
      return [];
    }
    return [...ids].map((id) => freezeClone(mountsById.get(id)));
  }

  /**
   * Spool配下のmount一覧を取得する。
   *
   * @function listMountsForSpool
   * @param {string} spoolId - spool ID。
   * @returns {Array<Object>} SpoolMount record配列。
   */
  function listMountsForSpool(spoolId) {
    const ids = mountIdsBySpool.get(spoolId);
    if (!ids) {
      return [];
    }
    return [...ids].map((id) => freezeClone(mountsById.get(id)));
  }

  /**
   * MaterialSourceのopen mountを取得する。
   *
   * @function getOpenMountForSource
   * @param {string} materialSourceId - MaterialSource ID。
   * @returns {Object|null} open SpoolMount record。
   */
  function getOpenMountForSource(materialSourceId) {
    const id = openMountIdBySource.get(materialSourceId);
    return id ? getMount(id) : null;
  }

  /**
   * Spoolのopen mountを取得する。
   *
   * @function getOpenMountForSpool
   * @param {string} spoolId - spool ID。
   * @returns {Object|null} open SpoolMount record。
   */
  function getOpenMountForSpool(spoolId) {
    const id = openMountIdBySpool.get(spoolId);
    return id ? getMount(id) : null;
  }

  /**
   * repositoryが保持するconflict一覧を取得する。
   *
   * @function getConflicts
   * @returns {Array<Object>} conflict record配列。
   */
  function getConflicts() {
    return conflicts.map((conflict) => freezeClone(conflict));
  }

  /**
   * repositoryのJSON snapshotを取得する。
   *
   * @function toJSON
   * @returns {Object} repository snapshot。
   */
  function toJSON() {
    return Object.freeze({
      mounts: Object.freeze([...mountsById.values()].map((mount) => freezeClone(mount))),
      conflicts: Object.freeze(getConflicts()),
    });
  }

  for (const mount of initialMounts) {
    const result = recordMount(mount);
    if (!result.ok) {
      throw new Error(`invalid initial spool mount repository input: ${result.errors.concat(result.conflicts.map((conflict) => conflict.reason)).join(",")}`);
    }
  }

  return Object.freeze({
    recordMount,
    getMount,
    listMountsForSource,
    listMountsForSpool,
    getOpenMountForSource,
    getOpenMountForSpool,
    getConflicts,
    toJSON,
  });
}
