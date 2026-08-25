/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 CFS command integration scaffold モジュール
 * @file dashboard_cfs_command_integration.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_cfs_command_integration
 *
 * 【機能内容サマリ】
 * - CFS/CFS-C UI intent を Printer Core v3 command request へ変換する
 * - bound dispatcher へ request だけを渡す fail-closed integration scaffold を提供する
 * - 既定では実送信を無効にし、production activation 前の接続境界だけを固定する
 *
 * 【公開関数一覧】
 * - {@link createCfsControlCommandRequest}：CFS操作intentからcommand requestを生成
 * - {@link dispatchCfsControlIntent}：CFS操作intentをbound dispatcherへ渡す
 *
 * @version 1.390.1380 (PR #432)
 * @since   1.390.1380 (PR #432)
 * @lastModified 2026-08-25 21:34:00
 * -----------------------------------------------------------
 * @todo
 * - actual adapter transport mapping と実機certificationが完了するまで production UI では enabled にしない
 */

"use strict";

import {
  createPrinterCommandRequest,
} from "./dashboard_command_authority.js";

/**
 * CFS UI action から Printer Core command kind への対応表。
 *
 * 【詳細説明】
 * - rendererはcommand requestを直接作らず、action/slot/sourceのintentだけを渡す。
 * - ここでPrinter Core command kindへ変換し、後段のcommand authorityでsend-time再検証する。
 *
 * @constant {Object<string,string>}
 */
const CFS_ACTION_COMMAND_KIND = Object.freeze({
  select: "cfs-slot-select",
  load: "cfs-load",
  unload: "cfs-unload",
  feed: "cfs-feed",
  retract: "cfs-retract",
});

/**
 * 任意値を空でない文字列へ正規化する。
 *
 * 【詳細説明】
 * - CFS source ID や command kind は空文字を許可しないため、trim後の値だけを採用する。
 *
 * @private
 * @param {*} value - 文字列候補
 * @returns {string|null} 空でない文字列、またはnull
 */
function toNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/**
 * 任意値を有限numberへ正規化する。
 *
 * 【詳細説明】
 * - protocolSlotId / slotIndex / boxId は fixture により number/string の揺れがあるため、
 *   request payload境界で有限numberまたはnullへ寄せる。
 *
 * @private
 * @param {*} value - 数値候補
 * @returns {number|null} 有限number、またはnull
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * CFS操作intentを正規化する。
 *
 * 【詳細説明】
 * - renderer由来のpayloadをそのままcommand requestへ使わず、action/source/slot/boxだけに限定する。
 * - commandKindが明示されている場合も、actionとの対応表に一致するものだけを採用する。
 *
 * @private
 * @param {object} intent - CFS操作intent
 * @returns {object} 正規化済みintent
 * @throws {TypeError} intentが不正な場合
 */
function normalizeCfsControlIntent(intent = {}) {
  const action = toNonEmptyString(intent.action);
  const expectedCommandKind = CFS_ACTION_COMMAND_KIND[action];
  if (!expectedCommandKind) {
    throw new TypeError("Unsupported CFS control action.");
  }
  const commandKind = toNonEmptyString(intent.commandKind) || expectedCommandKind;
  if (commandKind !== expectedCommandKind) {
    throw new TypeError("CFS control action and commandKind mismatch.");
  }
  const sourceId = toNonEmptyString(intent.sourceId);
  if (!sourceId) {
    throw new TypeError("CFS control intent requires sourceId.");
  }
  const slotId = toFiniteNumberOrNull(intent.protocolSlotId ?? intent.slotId ?? intent.slotIndex);
  return {
    action,
    commandKind,
    sourceId,
    displaySlot: toNonEmptyString(intent.displaySlot),
    unitIndex: toFiniteNumberOrNull(intent.unitIndex),
    slotIndex: toFiniteNumberOrNull(intent.slotIndex),
    boxId: toFiniteNumberOrNull(intent.boxId),
    protocolSlotId: slotId,
  };
}

/**
 * command context を正規化する。
 *
 * 【詳細説明】
 * - request生成に必要なdevice/sessionだけを受け取り、capabilityやtopologyはbound dispatcher側で
 *   送信直前に再取得する。
 *
 * @private
 * @param {object} context - command context候補
 * @returns {object} 正規化済みcommand context
 * @throws {TypeError} 必須IDが無い場合
 */
function normalizeCommandRequestContext(context = {}) {
  const deviceId = toNonEmptyString(context.deviceId);
  const sessionId = toNonEmptyString(context.sessionId);
  if (!deviceId || !sessionId) {
    throw new TypeError("CFS command request context requires deviceId and sessionId.");
  }
  return {
    deviceId,
    sessionId,
    transportKind: toNonEmptyString(context.transportKind) || "ws9999",
    idempotencyKey: toNonEmptyString(context.idempotencyKey),
    createdAt: toNonEmptyString(context.createdAt),
    entropySource: typeof context.entropySource === "function" ? context.entropySource : undefined,
  };
}

/**
 * CFS操作intentに対応する期待状態を返す。
 *
 * 【詳細説明】
 * - slot selectだけはNormalizedState上のselected sourceとして汎用的に確認できる。
 * - load/unload/feed/retractの物理・protocol semanticsは実機certification前なので、ここでは推測しない。
 *
 * @private
 * @param {object} normalizedIntent - 正規化済みCFS操作intent
 * @returns {Array<object>} expected-state条件
 */
function createCfsExpectedState(normalizedIntent) {
  if (normalizedIntent.action === "select") {
    return [{
      path: "materials.selectedSource.sourceId",
      operator: "equals",
      expected: normalizedIntent.sourceId,
    }];
  }
  return [];
}

/**
 * CFS操作intentからPrinter Core command requestを生成する。
 *
 * 【詳細説明】
 * - この関数はrequestを作るだけで、transport送信は行わない。
 * - capability/topology/source freshnessはrequest作成時ではなく、bound dispatcherのsend-time validationへ委ねる。
 *
 * @function createCfsControlCommandRequest
 * @param {object} intent - CFS操作intent
 * @param {object} context - command request context
 * @returns {object} Printer Core command request
 * @example
 * const request = createCfsControlCommandRequest(intent, { deviceId, sessionId });
 */
export function createCfsControlCommandRequest(intent = {}, context = {}) {
  const normalizedIntent = normalizeCfsControlIntent(intent);
  const requestContext = normalizeCommandRequestContext(context);
  return createPrinterCommandRequest({
    deviceId: requestContext.deviceId,
    sessionId: requestContext.sessionId,
    commandKind: normalizedIntent.commandKind,
    transportKind: requestContext.transportKind,
    payload: {
      action: normalizedIntent.action,
      sourceId: normalizedIntent.sourceId,
      displaySlot: normalizedIntent.displaySlot,
      unitIndex: normalizedIntent.unitIndex,
      slotIndex: normalizedIntent.slotIndex,
      boxId: normalizedIntent.boxId,
      protocolSlotId: normalizedIntent.protocolSlotId,
    },
    expectedState: createCfsExpectedState(normalizedIntent),
    idempotencyKey: requestContext.idempotencyKey,
    entropySource: requestContext.entropySource,
    createdAt: requestContext.createdAt,
  });
}

/**
 * CFS操作intentをbound dispatcherへ渡す。
 *
 * 【詳細説明】
 * - 既定では`enabled:true`が無い限り送信しない。これにより、scaffoldを読み込んでもproduction操作は開かない。
 * - UIやrendererはcontext provider / transport providerを渡さず、composition layerが用意したbound dispatcherだけを使う。
 *
 * @function dispatchCfsControlIntent
 * @param {object} intent - CFS操作intent
 * @param {object=} options - dispatch options
 * @param {boolean=} options.enabled - trueの場合だけrequest生成とdispatchを実行する
 * @param {object} options.dispatcher - `createBoundPrinterCommandDispatcher()` が返すbound dispatcher
 * @param {Function} options.getCommandContext - request生成用context provider
 * @returns {Promise<object>} dispatch結果ラッパ
 * @example
 * const result = await dispatchCfsControlIntent(intent, { enabled: true, dispatcher, getCommandContext });
 */
export async function dispatchCfsControlIntent(intent = {}, options = {}) {
  if (options.enabled !== true) {
    return {
      accepted: false,
      reason: "cfs-command-integration-disabled",
    };
  }
  if (!options.dispatcher || typeof options.dispatcher.dispatch !== "function") {
    return {
      accepted: false,
      reason: "missing-bound-dispatcher",
    };
  }
  if (typeof options.getCommandContext !== "function") {
    return {
      accepted: false,
      reason: "missing-command-context-provider",
    };
  }
  let request;
  try {
    request = createCfsControlCommandRequest(intent, await options.getCommandContext(intent));
  } catch (error) {
    return {
      accepted: false,
      reason: "invalid-cfs-command-intent",
      error: {
        message: error?.message || String(error),
      },
    };
  }
  return {
    accepted: true,
    request,
    result: await options.dispatcher.dispatch(request),
  };
}
