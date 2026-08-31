/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Universal MaterialSource migration journal モジュール
 * @file dashboard_material_accounting_migration_journal.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_accounting_migration_journal
 *
 * 【機能内容サマリ】
 * - Gate 18.9B の Universal MaterialSource migration dry-run journalを提供
 * - migration plan / evidenceのみを耐久保存し、MaterialSourceやSpoolMountのauthority writeを行わない
 * - 保存済みjournalの破損entryを隔離し、再起動後のblind cutoverを防ぐ
 *
 * 【公開関数一覧】
 * - {@link createMaterialAccountingMigrationJournal}：空journalまたは保存済みjournalを正規化
 * - {@link normalizeStoredMaterialAccountingMigrationJournal}：保存済みjournalを復元用に正規化
 * - {@link recordMaterialAccountingMigrationDryRunPlan}：valid dry-run planをjournalへ記録
 *
 * @version 1.390.1506 (PR #438)
 * @since   1.390.1506 (PR #438)
 * @lastModified 2026-08-31 12:13:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 18.9B後続でIndexedDB物理migrationJournal storeへ接続する
 */

"use strict";

import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";
import { validateMaterialAccountingMigrationDryRunPlan } from "./dashboard_material_accounting_migration_planner.js";

/**
 * Material accounting migration journal schema version。
 *
 * @constant {number}
 */
export const MATERIAL_ACCOUNTING_MIGRATION_JOURNAL_SCHEMA_VERSION = 1;

/**
 * JSON互換値をcloneする。
 *
 * 【詳細説明】
 * - journalは保存境界なので、呼び出し元のplan mutationが後から混入しないようcloneする。
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
 * event IDを生成する。
 *
 * @private
 * @function createJournalEventId
 * @param {Object} input - event入力。
 * @param {string} input.migrationId - migration ID。
 * @param {string} input.sourceChecksum - source checksum。
 * @param {string} input.recordedAt - 記録日時。
 * @returns {string} deterministic event ID。
 */
function createJournalEventId(input) {
  return createPrinterCoreV3DeterministicId("material-migration-journal-event", [
    input.migrationId,
    input.sourceChecksum,
    input.recordedAt,
  ]);
}

/**
 * 空journal shapeを生成する。
 *
 * @private
 * @function createEmptyJournalShape
 * @returns {Object} 空journal。
 */
function createEmptyJournalShape() {
  return {
    schemaVersion: MATERIAL_ACCOUNTING_MIGRATION_JOURNAL_SCHEMA_VERSION,
    authority: "migration-dry-run-journal",
    latestMigrationId: null,
    byMigrationId: {},
    events: [],
    retainedUnsupportedEntries: [],
    invariants: {
      activateUniversalWrites: false,
      materialSourceRepositoryWrites: false,
      spoolMountRepositoryWrites: false,
      migrationJournalIsEvidenceOnly: true,
    },
  };
}

/**
 * journal resultを生成する。
 *
 * @private
 * @function createJournalResult
 * @param {Object} input - result入力。
 * @param {boolean} input.ok - 成功可否。
 * @param {string} input.action - action名。
 * @param {Object} input.journal - journal snapshot。
 * @param {?string=} input.reason - 失敗理由。
 * @returns {Object} journal result。
 */
function createJournalResult(input) {
  const result = {
    ok: input.ok,
    action: input.action,
    journal: input.journal,
  };
  if (input.reason) {
    result.reason = input.reason;
  }
  return deepFreezeJson(result);
}

/**
 * planをjournal entryへ変換する。
 *
 * @private
 * @function createJournalEntry
 * @param {Object} plan - migration dry-run plan。
 * @param {string} recordedAt - 記録日時。
 * @returns {Object} journal entry。
 */
function createJournalEntry(plan, recordedAt) {
  return {
    migrationId: plan.migrationId,
    sourceChecksum: plan.source?.checksum || null,
    migrationStatus: plan.migrationStatus,
    recordedAt,
    plan: cloneJsonValue(plan),
  };
}

/**
 * journal eventを生成する。
 *
 * @private
 * @function createRecordedEvent
 * @param {Object} entry - journal entry。
 * @returns {Object} journal event。
 */
function createRecordedEvent(entry) {
  return {
    eventId: createJournalEventId(entry),
    type: "migration-dry-run-recorded",
    migrationId: entry.migrationId,
    sourceChecksum: entry.sourceChecksum,
    recordedAt: entry.recordedAt,
  };
}

/**
 * journalへ保持してよいeventか判定する。
 *
 * @private
 * @function isSupportedJournalEvent
 * @param {*} event - event候補。
 * @param {Set<string>} migrationIds - 有効なmigrationId集合。
 * @returns {boolean} 保持可能なeventならtrue。
 */
function isSupportedJournalEvent(event, migrationIds) {
  return event && typeof event === "object" &&
    toTrimmedString(event.eventId) &&
    event.type === "migration-dry-run-recorded" &&
    migrationIds.has(toTrimmedString(event.migrationId));
}

/**
 * 保存済みjournalを復元用に正規化する。
 *
 * 【詳細説明】
 * - 壊れたplanは削除せず`retainedUnsupportedEntries`へ移し、後続UI/サポートで確認できるようにする。
 * - valid entryだけを`byMigrationId`へ戻すため、復元直後にauthority writeへ誤投影されない。
 *
 * @function normalizeStoredMaterialAccountingMigrationJournal
 * @param {Object|null|undefined} stored - 保存済みjournal。
 * @returns {Object} 正規化済みjournal。
 * @example
 * const journal = normalizeStoredMaterialAccountingMigrationJournal(saved);
 */
export function normalizeStoredMaterialAccountingMigrationJournal(stored) {
  const journal = createEmptyJournalShape();
  const source = stored && typeof stored === "object" ? stored : {};
  const entries = source.byMigrationId && typeof source.byMigrationId === "object" && !Array.isArray(source.byMigrationId)
    ? source.byMigrationId
    : {};

  for (const [key, value] of Object.entries(entries)) {
    const migrationId = toTrimmedString(value?.migrationId || key);
    const plan = value?.plan;
    const validation = validateMaterialAccountingMigrationDryRunPlan(plan);
    if (!migrationId || !validation.ok || plan?.migrationId !== migrationId) {
      journal.retainedUnsupportedEntries.push({
        migrationId: migrationId || key,
        reason: "plan-not-object-or-invalid",
        errors: validation.errors || ["plan-not-object"],
        entry: cloneJsonValue(value),
      });
      continue;
    }
    journal.byMigrationId[migrationId] = {
      migrationId,
      sourceChecksum: plan.source?.checksum || value.sourceChecksum || null,
      migrationStatus: plan.migrationStatus,
      recordedAt: normalizeOptionalIsoTime(value.recordedAt) || plan.createdAt || null,
      plan: cloneJsonValue(plan),
    };
  }

  const validMigrationIds = new Set(Object.keys(journal.byMigrationId));
  journal.events = (Array.isArray(source.events) ? source.events : [])
    .filter((event) => isSupportedJournalEvent(event, validMigrationIds))
    .map((event) => cloneJsonValue(event));

  const requestedLatest = toTrimmedString(source.latestMigrationId);
  if (requestedLatest && journal.byMigrationId[requestedLatest]) {
    journal.latestMigrationId = requestedLatest;
  } else {
    journal.latestMigrationId = journal.events.at(-1)?.migrationId || Object.keys(journal.byMigrationId).at(-1) || null;
  }

  return deepFreezeJson(journal);
}

/**
 * 空journalまたは保存済みjournalを正規化する。
 *
 * @function createMaterialAccountingMigrationJournal
 * @param {Object|null|undefined} [stored=null] - 保存済みjournal。
 * @returns {Object} 正規化済みjournal。
 * @example
 * const journal = createMaterialAccountingMigrationJournal(saved);
 */
export function createMaterialAccountingMigrationJournal(stored = null) {
  return normalizeStoredMaterialAccountingMigrationJournal(stored);
}

/**
 * migration dry-run planをjournalへ記録する。
 *
 * 【詳細説明】
 * - valid dry-run planのみ保存する。
 * - 同一migrationId/sourceChecksumの再保存は冪等に扱い、eventを重複させない。
 * - 同一migrationIdで異なるchecksumが来た場合は、既存entryを守ってconflictを返す。
 *
 * @function recordMaterialAccountingMigrationDryRunPlan
 * @param {Object|null|undefined} journalInput - 既存journal。
 * @param {Object|null|undefined} plan - migration dry-run plan。
 * @param {Object=} options - 記録オプション。
 * @param {string=} options.recordedAt - 記録日時。
 * @returns {{ok:boolean, action:string, journal:Object, reason:string=}} 記録結果。
 * @example
 * const result = recordMaterialAccountingMigrationDryRunPlan(journal, plan, { recordedAt: new Date().toISOString() });
 */
export function recordMaterialAccountingMigrationDryRunPlan(journalInput, plan, options = {}) {
  const journal = cloneJsonValue(normalizeStoredMaterialAccountingMigrationJournal(journalInput));
  const validation = validateMaterialAccountingMigrationDryRunPlan(plan);
  if (!validation.ok) {
    return createJournalResult({
      ok: false,
      action: "invalid-plan",
      reason: validation.errors[0] || "invalid-plan",
      journal: deepFreezeJson(journal),
    });
  }

  const migrationId = toTrimmedString(plan.migrationId);
  const sourceChecksum = toTrimmedString(plan.source?.checksum);
  const existing = journal.byMigrationId[migrationId];
  if (existing) {
    if (existing.sourceChecksum !== sourceChecksum) {
      return createJournalResult({
        ok: false,
        action: "conflict",
        reason: "migration-journal-plan-conflict",
        journal: deepFreezeJson(journal),
      });
    }
    return createJournalResult({
      ok: true,
      action: "noop",
      journal: deepFreezeJson(journal),
    });
  }

  const recordedAt = normalizeOptionalIsoTime(options.recordedAt) || new Date().toISOString();
  const entry = createJournalEntry(plan, recordedAt);
  journal.byMigrationId[migrationId] = entry;
  journal.latestMigrationId = migrationId;
  journal.events.push(createRecordedEvent(entry));

  return createJournalResult({
    ok: true,
    action: "insert",
    journal: deepFreezeJson(journal),
  });
}
