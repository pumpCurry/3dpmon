/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 K2 CFS command transport モジュール
 * @file dashboard_k2_cfs_command_transport.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_k2_cfs_command_transport
 *
 * 【機能内容サマリ】
 * - Printer Core v3 command request を K2 WS9999 の送信frame候補へ変換
 * - CFS print-start では `colorMatch` と `multiColorPrint` の明示割当だけを扱う
 * - 未certifiedのslot操作や外部スプールfallbackをfail-closedに拒否する
 *
 * 【公開関数一覧】
 * - {@link createK2CfsCommandTransportPlan}：command request から送信計画を生成
 * - {@link sendK2CfsCommandTransportPlan}：送信計画を注入済みsend hookで順次送信
 *
 * @version 1.390.1384 (PR #432)
 * @since   1.390.1384 (PR #432)
 * @lastModified 2026-08-26 09:20:00
 * -----------------------------------------------------------
 * @todo
 * - K2実機Gateでslot select/load/unload/feed/retractのLAN commandをcertifyしてから追加する
 */

"use strict";

/**
 * このmoduleで扱うK2/CFS transport plan schema version。
 *
 * 【詳細説明】
 * - Printer Core command schemaとは別に、WS9999へ出すframe列の契約versionを持たせる。
 *
 * @constant {number}
 */
export const K2_CFS_COMMAND_TRANSPORT_PLAN_SCHEMA_VERSION = 1;

/**
 * K2/CFS print-startで採用するWS9999 transport profile名。
 *
 * 【詳細説明】
 * - OrcaSlicer の K2 family CFS print path が `set colorMatch` -> `set multiColorPrint`
 *   を送る公開ソース根拠に基づく。slot単体操作とは別profileとして扱う。
 *
 * @constant {string}
 */
export const K2_CFS_PRINT_START_TRANSPORT_PROFILE = "k2-ws9999-color-match-multicolor-v1";

/**
 * K2/CFSでまだ実機certificationが済んでいないcommand kind。
 *
 * 【詳細説明】
 * - UI上は候補ボタンがあるが、LAN command keyが未確定のためtransport plan生成時点で拒否する。
 *
 * @constant {Set<string>}
 */
const UNCERTIFIED_CFS_SLOT_COMMAND_KINDS = Object.freeze(new Set([
  "cfs-slot-select",
  "cfs-load",
  "cfs-unload",
  "cfs-feed",
  "cfs-retract",
]));

/**
 * 任意値を空でない文字列へ正規化する。
 *
 * 【詳細説明】
 * - protocol alias / path / source id は空文字を送信frameへ載せない。
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
 * - protocolのboxId/materialIdは整数である必要があるため、有限numberだけを採用する。
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
 * 失敗したtransport planを返す。
 *
 * 【詳細説明】
 * - callerが例外処理へ逃げず、command resultへ理由を写しやすいplain objectで返す。
 *
 * @private
 * @param {string} reason - 失敗理由
 * @param {object=} details - 追加詳細
 * @returns {object} 失敗transport plan
 */
function createRejectedTransportPlan(reason, details = {}) {
  return {
    schemaVersion: K2_CFS_COMMAND_TRANSPORT_PLAN_SCHEMA_VERSION,
    ok: false,
    reason,
    transportKind: "ws9999",
    profile: null,
    frames: [],
    details: {
      ...details,
    },
  };
}

/**
 * sourceIdからCFS box/material locationを取り出す。
 *
 * 【詳細説明】
 * - NormalizedStateでは `cfs:<boxId>:slot:<slotId>` を一時sourceIdとして使っている。
 * - external sourceはCFS print-startの明示割当として扱わず、外部スプールfallbackへ落とさない。
 *
 * @private
 * @param {string|null|undefined} sourceId - material source id
 * @returns {{kind: string, boxId: number|null, materialId: number|null}} 解析結果
 */
function parseMaterialSourceLocation(sourceId) {
  const text = toNonEmptyString(sourceId);
  if (!text) {
    return { kind: "missing", boxId: null, materialId: null };
  }
  const cfsMatch = /^cfs:(\d+):slot:(\d+)$/u.exec(text);
  if (cfsMatch) {
    return {
      kind: "cfs-slot",
      boxId: Number(cfsMatch[1]),
      materialId: Number(cfsMatch[2]),
    };
  }
  const externalMatch = /^external:(\d+):slot:(\d+)$/u.exec(text);
  if (externalMatch) {
    return {
      kind: "external-spool",
      boxId: Number(externalMatch[1]),
      materialId: Number(externalMatch[2]),
    };
  }
  return { kind: "unknown", boxId: null, materialId: null };
}

/**
 * command payloadからprinter-local G-code pathを取得する。
 *
 * 【詳細説明】
 * - PrintPlan command payloadでは asset.path をauthority側が持つ。
 * - WS9999 `colorMatch.path` と `multiColorPrint.gcode` は `printprt:` prefixなしの
 *   printer-local pathを期待するため、誤って二重prefixにならないよう正規化する。
 *
 * @private
 * @param {object|null|undefined} payload - command request payload
 * @returns {string|null} printer-local path
 */
function getPrinterLocalGcodePath(payload) {
  const rawPath = toNonEmptyString(payload?.asset?.path || payload?.asset?.remotePath || payload?.path);
  if (!rawPath) {
    return null;
  }
  return rawPath.replace(/^printprt:/u, "");
}

/**
 * tool assignmentをK2 `colorMatch.list[]` entryへ変換する。
 *
 * 【詳細説明】
 * - `id` は Creality protocol alias (`T1A`など) をそのまま使う。
 * - `type` / `color` は実機に渡す材料識別補助なので、PrintPlan側のprotocol evidenceまたはmaterial metadataから取得する。
 * - box/material locationはsourceIdを基準にし、callerがpayloadへ別boxIdを混ぜても採用しない。
 *
 * @private
 * @param {object} assignment - PrintPlan tool assignment
 * @returns {{ok: boolean, entry: object|null, reason: string|null, sourceId: string|null}} 変換結果
 */
function createColorMatchEntry(assignment) {
  const sourceId = toNonEmptyString(assignment?.materialSourceId);
  const location = parseMaterialSourceLocation(sourceId);
  if (location.kind !== "cfs-slot") {
    return {
      ok: false,
      entry: null,
      reason: location.kind === "external-spool" ? "external-source-print-start-not-certified" : "invalid-cfs-source-id",
      sourceId,
    };
  }
  const alias = toNonEmptyString(assignment?.protocolToolAlias || assignment?.protocol?.colorMatch);
  if (!alias) {
    return {
      ok: false,
      entry: null,
      reason: "missing-protocol-tool-alias",
      sourceId,
    };
  }
  const type = toNonEmptyString(
    assignment?.protocol?.materialType ||
    assignment?.protocol?.type ||
    assignment?.material?.type
  );
  const color = toNonEmptyString(
    assignment?.protocol?.color ||
    assignment?.material?.color?.normalized ||
    assignment?.material?.color?.raw
  );
  if (!type || !color) {
    return {
      ok: false,
      entry: null,
      reason: "missing-material-protocol-evidence",
      sourceId,
    };
  }
  return {
    ok: true,
    entry: {
      id: alias,
      type,
      color,
      boxId: location.boxId,
      materialId: location.materialId,
    },
    reason: null,
    sourceId,
  };
}

/**
 * K2/CFS print-start用のtransport frame列を生成する。
 *
 * 【詳細説明】
 * - `opGcodeFile` fallbackはここでは一切生成しない。
 * - CFS sourceが一つでも外部スプールへ向く場合は、乾走の再発防止のため未certifiedとして拒否する。
 * - `colorMatch` と `multiColorPrint` は同じG-code pathへbindし、adapterが後から推測しない形にする。
 *
 * @private
 * @param {object} request - Printer Core command request
 * @returns {object} transport plan
 */
function createK2CfsPrintStartPlan(request) {
  const payload = request?.payload && typeof request.payload === "object" ? request.payload : {};
  const path = getPrinterLocalGcodePath(payload);
  if (!path) {
    return createRejectedTransportPlan("missing-gcode-path");
  }
  const assignments = Array.isArray(payload.toolAssignments) ? payload.toolAssignments : [];
  if (assignments.length === 0) {
    return createRejectedTransportPlan("missing-tool-assignments");
  }
  const colorMatchList = [];
  for (const assignment of assignments) {
    const result = createColorMatchEntry(assignment);
    if (!result.ok) {
      return createRejectedTransportPlan(result.reason, {
        sourceId: result.sourceId,
      });
    }
    colorMatchList.push(result.entry);
  }
  return {
    schemaVersion: K2_CFS_COMMAND_TRANSPORT_PLAN_SCHEMA_VERSION,
    ok: true,
    reason: null,
    transportKind: "ws9999",
    profile: K2_CFS_PRINT_START_TRANSPORT_PROFILE,
    frames: [
      {
        method: "set",
        params: {
          colorMatch: {
            path,
            list: colorMatchList,
          },
        },
      },
      {
        method: "set",
        params: {
          multiColorPrint: {
            gcode: path,
            enableSelfTest: toFiniteNumberOrNull(payload?.startOptions?.enableSelfTest) ?? 0,
          },
        },
      },
    ],
    details: {
      commandKind: request.commandKind,
      printPlanId: payload.printPlanId || null,
      assignmentCount: colorMatchList.length,
    },
  };
}

/**
 * Printer Core command request から K2/CFS transport plan を生成する。
 *
 * 【詳細説明】
 * - `print-start` 以外のCFS操作は、LAN command keyが未certifiedなので拒否する。
 * - `print-start` でもCFS明示割当が足りない場合は拒否する。
 *
 * @function createK2CfsCommandTransportPlan
 * @param {object|null|undefined} request - Printer Core command request
 * @returns {object} K2/CFS transport plan
 * @example
 * const plan = createK2CfsCommandTransportPlan(request);
 */
export function createK2CfsCommandTransportPlan(request) {
  const commandKind = toNonEmptyString(request?.commandKind);
  if (!commandKind) {
    return createRejectedTransportPlan("missing-command-kind");
  }
  if (UNCERTIFIED_CFS_SLOT_COMMAND_KINDS.has(commandKind)) {
    return createRejectedTransportPlan("uncertified-cfs-slot-command", { commandKind });
  }
  if (commandKind !== "print-start") {
    return createRejectedTransportPlan("unsupported-k2-cfs-command-kind", { commandKind });
  }
  return createK2CfsPrintStartPlan(request);
}

/**
 * K2/CFS transport plan をsend hookで順次送信する。
 *
 * 【詳細説明】
 * - 実WebSocketはこのmoduleへ直接渡さず、接続層が所有するsend hookへframeだけを渡す。
 * - `ok:false` のplanは送信せず例外にし、dispatcher側のtransport-error/resultへ委ねる。
 *
 * @function sendK2CfsCommandTransportPlan
 * @param {object} plan - {@link createK2CfsCommandTransportPlan} の戻り値
 * @param {Function} sendFrame - frame送信hook
 * @returns {Promise<object>} transport response summary
 * @throws {Error} plan不正またはsend hook不正の場合
 * @example
 * await sendK2CfsCommandTransportPlan(plan, (frame) => sendCommand(frame.method, frame.params, host));
 */
export async function sendK2CfsCommandTransportPlan(plan, sendFrame) {
  if (!plan?.ok) {
    throw new Error(`K2 CFS command transport plan rejected: ${plan?.reason || "unknown"}`);
  }
  if (typeof sendFrame !== "function") {
    throw new TypeError("K2 CFS command transport requires a sendFrame hook.");
  }
  const responses = [];
  for (let index = 0; index < plan.frames.length; index += 1) {
    const frame = plan.frames[index];
    // colorMatchとmultiColorPrintの順序が意味を持つため、並列送信せず必ず逐次awaitする。
    responses.push(await sendFrame(frame, {
      index,
      profile: plan.profile,
      frameCount: plan.frames.length,
    }));
  }
  return {
    status: "acknowledged",
    protocolCommandId: `${plan.profile}:${plan.details?.printPlanId || "print-start"}`,
    profile: plan.profile,
    sentFrameCount: responses.length,
    responses,
  };
}
