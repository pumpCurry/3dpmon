/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 CFS Debug / Certification パネルモジュール
 * @file dashboard_cfs_certification_panel.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_cfs_certification_panel
 *
 * 【機能内容サマリ】
 * - Hybrid Filament UI案の広いCFS Debug / Certificationパネルを生成
 * - read-only probe、preflight、dry-run plan、live arm、evidence timeline、exportを分離表示
 * - 未認証/未ARM/状態変化時にLIVE送信をfail-closedで無効表示
 *
 * 【公開関数一覧】
 * - {@link createCfsCertificationPanelViewModel}：Certificationパネル用ViewModelを生成
 * - {@link renderCfsCertificationPanel}：CertificationパネルViewModelをDOMへ描画
 * - {@link createCfsCertificationExportBundle}：レビュー/fixture化用の証跡bundleを生成
 *
 * @version 1.390.1645 (PR #440)
 * @since   1.390.1469 (PR #436)
 * @lastModified 2026-09-02 15:26:05
 * -----------------------------------------------------------
 * @todo
 * - Gate 19 live certification後に、registry登録済みcommandだけLIVE送信ボタンへ接続する
 * - Gate 19.5以降でfresh observationによる復旧ラッチ自動解決を接続する
 */

"use strict";

import { redactProtocolValue } from "./dashboard_protocol_recorder.js";
import { createCfsSessionCorrelationEvidence } from "./dashboard_cfs_session_correlation.js";

/**
 * CFS Certification パネルViewModelのschema version。
 *
 * 【詳細説明】
 * - 通常のMaterialTopology ViewModelとは別に、危険操作検証UIの契約変更を追跡する。
 *
 * @constant {number}
 */
export const CFS_CERTIFICATION_PANEL_SCHEMA_VERSION = 1;

/**
 * Certificationパネルで既定表示するcommand kind。
 *
 * 【詳細説明】
 * - 実送信ではなくdry-run候補表示用の初期値。装填/取り外し検証に入りやすい `cfs-load` を採用する。
 *
 * @constant {string}
 */
const DEFAULT_COMMAND_KIND = "cfs-load";

/**
 * Certificationパネルのmanifest名。
 *
 * 【詳細説明】
 * - export bundleやログ上で通常フィラメントカードと混同しないための固定識別子。
 *
 * @constant {string}
 */
const CERTIFICATION_PANEL_NAME = "cfs-debug-certification";

/**
 * 任意値を空でない文字列へ正規化する。
 *
 * 【詳細説明】
 * - device/session/sourceなど、表示と束縛判定に使うIDを空文字/nullで区別しやすくする。
 *
 * @private
 * @param {*} value - 文字列候補
 * @param {string=} fallback - 空値時のfallback
 * @returns {string} 正規化済み文字列
 */
function toText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/**
 * 任意値をbooleanへ正規化する。
 *
 * 【詳細説明】
 * - saved JSONやtest fixture由来でboolean以外が来ても、UI境界で明示的にtrueだけを採用する。
 *
 * @private
 * @param {*} value - boolean候補
 * @returns {boolean} trueの場合だけtrue
 */
function isTrue(value) {
  return value === true;
}

/**
 * JSON化可能な値を安全に複製する。
 *
 * 【詳細説明】
 * - export bundleへDOMや関数参照を混ぜず、レビューに渡しやすい純粋JSONへ寄せる。
 *
 * @private
 * @param {*} value - 複製対象
 * @returns {*} JSON化可能な複製値
 */
function cloneJson(value) {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return null;
  }
}

/**
 * redaction後bundle内の自由記述文字列からraw session IDを除去する。
 *
 * 【詳細説明】
 * - Protocol Recorderは`sessionId` keyの値は秘匿するが、preflight detailのような自由記述文字列に
 *   埋め込まれたsession IDはkey名だけでは検出できない。
 * - Certification exportは対象sessionを既に知っているため、既知のraw session文字列だけを
 *   redacted printer.sessionId tokenへ置換して、通常文言への過剰redactionを避ける。
 *
 * @private
 * @function replaceKnownSessionText
 * @param {*} value - redaction後bundle値。
 * @param {string} rawSessionId - export前のraw session ID。
 * @param {string} replacement - redaction済みsession token。
 * @returns {*} raw session文字列置換済み値。
 */
function replaceKnownSessionText(value, rawSessionId, replacement) {
  const sessionText = toText(rawSessionId);
  const replacementText = toText(replacement, "<SESSION_ID>");
  if (!sessionText || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceKnownSessionText(entry, sessionText, replacementText));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, childValue] of Object.entries(value)) {
      result[key] = replaceKnownSessionText(childValue, sessionText, replacementText);
    }
    return result;
  }
  if (typeof value !== "string") {
    return value;
  }
  return value.split(sessionText).join(replacementText);
}

/**
 * 表示用日時を `yyyy-mm-dd hh:mm:ss` に変換する。
 *
 * 【詳細説明】
 * - Certification操作は物理観測時刻との対応が重要なので、ISO文字列をローカル時刻で人間向けに表示する。
 *
 * @private
 * @param {*} value - 日時候補
 * @returns {string} 表示日時、または `--`
 */
function formatLocalDateTime(value) {
  if (value === null || value === undefined || value === "") {
    return "--";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "--";
  }
  const pad = (numberValue) => String(numberValue).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":");
}

/**
 * material view modelから表示対象source一覧を平坦化する。
 *
 * 【詳細説明】
 * - 外部スプールとCFS slotは表示上分離するが、選択中source探索では両方を候補に含める。
 *
 * @private
 * @param {object|null|undefined} materialViewModel - material topology view model
 * @returns {Array<object>} source row一覧
 */
function flattenMaterialRows(materialViewModel) {
  const externalRows = Array.isArray(materialViewModel?.external) ? materialViewModel.external : [];
  const unitRows = Array.isArray(materialViewModel?.units) ? materialViewModel.units : [];
  const cfsRows = unitRows.flatMap((unit) => Array.isArray(unit?.slots) ? unit.slots : []);
  return [...externalRows, ...cfsRows];
}

/**
 * Certification対象sourceを決定する。
 *
 * 【詳細説明】
 * - 明示sourceがあればそれを優先し、無ければ現在selectedのCFS slot、さらに最初のloaded CFS slotへfallbackする。
 * - 外部スプールはCFS slot操作候補の対象外なので、fallbackでは採用しない。
 *
 * @private
 * @param {object|null|undefined} materialViewModel - material topology view model
 * @param {object|null|undefined} explicitSource - 明示source
 * @returns {object|null} 対象source row
 */
function resolveTargetSource(materialViewModel, explicitSource) {
  if (explicitSource?.sourceId) {
    return explicitSource;
  }
  const rows = flattenMaterialRows(materialViewModel)
    .filter((row) => row?.kind === "cfs-slot" && row.sourceId);
  return rows.find((row) => row.selected === true)
    || rows.find((row) => row.presence === "loaded")
    || rows[0]
    || null;
}

/**
 * source rowに紐づくassignment表示を生成する。
 *
 * 【詳細説明】
 * - T1A/T1Cなどは物理slot名ではなく印刷/G-code側の割当なので、裸文字列ではなく説明語を付ける。
 *
 * @private
 * @param {object|null|undefined} source - source row
 * @returns {string} assignment表示
 */
function formatAssignment(source) {
  const assignments = Array.isArray(source?.assignments) ? source.assignments : [];
  const text = assignments
    .map((assignment) => assignment?.assignmentId)
    .filter(Boolean)
    .join(", ");
  return text ? `印刷割当 ${text}` : "印刷割当 未観測";
}

/**
 * source rowの材料名を表示用に整形する。
 *
 * 【詳細説明】
 * - 材料名が無い場合でもtypeがあればtypeを表示し、全く無い場合は未観測として扱う。
 *
 * @private
 * @param {object|null|undefined} source - source row
 * @returns {string} 材料表示
 */
function formatMaterial(source) {
  const material = source?.material || {};
  return toText(material.name || material.type, "--");
}

/**
 * source rowの残量を表示用に整形する。
 *
 * 【詳細説明】
 * - invalid値を0%扱いにせず、通常フィラメントカードと同じく不明として表示する。
 *
 * @private
 * @param {object|null|undefined} source - source row
 * @returns {string} 残量表示
 */
function formatRemaining(source) {
  const remaining = source?.status?.remaining || {};
  if (remaining.valid === false) {
    return "残量 不明";
  }
  const percent = Number(remaining.displayPercent);
  return Number.isFinite(percent) ? `残量 ${Math.round(percent)}%` : "残量 未観測";
}

/**
 * source rowのselection妥当性を取得する。
 *
 * 【詳細説明】
 * - MaterialTopology ViewModelでは `status.selectionValid` に保持する。
 * - 古いfixtureやテスト補助値が直接 `selectionValid` を持つ場合も読み、debug panelの表示境界で吸収する。
 *
 * @private
 * @function getSourceSelectionValid
 * @param {object|null|undefined} source - source row
 * @returns {boolean|null|undefined} selection妥当性
 */
function getSourceSelectionValid(source) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  if (source.status && Object.prototype.hasOwnProperty.call(source.status, "selectionValid")) {
    return source.status.selectionValid;
  }
  return source.selectionValid;
}

/**
 * selection証跡の完全性確認が必要なsource rowか判定する。
 *
 * 【詳細説明】
 * - `loaded` は物理的に材料があるため、選択状態が不定なら一意selectedを証明できない。
 * - `unknown` は装填有無が不明な実観測sourceとして扱い、安全側でselection証跡を要求する。
 * - `unobserved` は固定枠placeholderとして生成されることがあり、CLIの実boxsInfo sourceには出ないため、このpanelではfalse-blockingを避ける。
 *
 * @private
 * @function requiresSelectionEvidence
 * @param {object|null|undefined} row - source row
 * @returns {boolean} selection証跡確認対象ならtrue
 */
function requiresSelectionEvidence(row) {
  const presence = toText(row?.presence, "unobserved");
  return presence === "loaded" || presence === "unknown";
}

/**
 * live送信前に表示すべきselection証跡問題を生成する。
 *
 * 【詳細説明】
 * - CLI側のpre-command guardと同じ考え方で、実観測されたloaded/unknown sourceは選択状態が0/1系として観測済みであることを要求する。
 * - 固定枠として生成されたunobserved placeholderは、boxsInfo由来の実sourceではないため判定対象から外す。
 * - invalidは装置値の意味が壊れているため専用文言にし、missing/nullは観測不足として区別する。
 *
 * @private
 * @function createSelectionEvidencePreflightDetail
 * @param {object|null|undefined} materialViewModel - material topology view model
 * @returns {{state:string, detail:string}} preflight表示
 */
function createSelectionEvidencePreflightDetail(materialViewModel) {
  const rows = flattenMaterialRows(materialViewModel)
    .filter((row) => requiresSelectionEvidence(row));
  const invalidRows = rows.filter((row) => getSourceSelectionValid(row) === false);
  if (invalidRows.length > 0) {
    const slots = invalidRows.map((row) => toText(row.displaySlot || row.sourceId, "--")).join(", ");
    return { state: "fail", detail: `選択値異常: ${slots}` };
  }
  const incompleteRows = rows.filter((row) => getSourceSelectionValid(row) !== true);
  if (incompleteRows.length > 0) {
    const slots = incompleteRows.map((row) => toText(row.displaySlot || row.sourceId, "--")).join(", ");
    return { state: "fail", detail: `選択状態未観測: ${slots}` };
  }
  return {
    state: "ok",
    detail: rows.length > 0 ? `選択証跡OK: ${rows.length} sources` : "対象sourceなし",
  };
}

/**
 * printer idle preflightの詳細を生成する。
 *
 * 【詳細説明】
 * - `idle` という表示ラベルがあっても、Gate 19のread-only probeがpartial / unknown-core-stateを示す場合は
 *   物理操作可能なidle証明として扱わない。
 * - 未観測はwarnとして残し、`createLiveSendReadiness()` 側で selected-source 以外のwarnをhard blockする。
 *
 * @private
 * @function createPrinterIdlePreflightDetail
 * @param {object|null|undefined} printer - printer/session情報
 * @returns {{state:string, detail:string}} preflight表示
 */
function createPrinterIdlePreflightDetail(printer) {
  const printerState = toText(printer?.printState || printer?.state, "");
  const idleObservation = printer?.printerIdleObservation && typeof printer.printerIdleObservation === "object"
    ? printer.printerIdleObservation
    : null;
  if (idleObservation) {
    const status = toText(idleObservation.status, "").toLowerCase();
    const expiresAtMs = Date.parse(toText(idleObservation.expiresAt, ""));
    const nowMs = Date.now();
    if (idleObservation.fresh !== true || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      return {
        state: "fail",
        detail: "idle未証明: stale",
      };
    }
    if (!["observed", "assembled"].includes(status) ||
        idleObservation.snapshotCompleteness !== "complete" ||
        idleObservation.coreStateComplete !== true) {
      return {
        state: "fail",
        detail: "idle未証明: incomplete",
      };
    }
    if (idleObservation.idle !== true) {
      return {
        state: "fail",
        detail: toText(idleObservation.activityState || printerState, "idle未証明"),
      };
    }
  }
  const probeStatus = toText(printer?.statusProbeStatus || printer?.printStatusProbeStatus, "");
  const activityState = toText(printer?.printActivityState || printer?.activityState, "");
  const incompleteReasons = [];
  if (["partial", "timeout"].includes(probeStatus.toLowerCase())) {
    incompleteReasons.push(probeStatus.toLowerCase());
  }
  if (["unknown-core-state", "active-without-core-state"].includes(activityState.toLowerCase())) {
    incompleteReasons.push(activityState.toLowerCase());
  }
  if (printer?.coreStateComplete === false || printer?.printCoreStateComplete === false) {
    if (!incompleteReasons.includes("unknown-core-state")) {
      incompleteReasons.push("unknown-core-state");
    }
  }
  if (incompleteReasons.length > 0) {
    return {
      state: "fail",
      detail: `idle未証明: ${[...new Set(incompleteReasons)].join(" / ")}`,
    };
  }
  if (!printerState) {
    return {
      state: "warn",
      detail: "印刷状態未観測",
    };
  }
  const printerIdle = ["idle", "standby", "ready"].includes(printerState.toLowerCase());
  return {
    state: printerIdle ? "ok" : "fail",
    detail: printerState,
  };
}

/**
 * 復旧ラッチblockerを表示用に正規化する。
 *
 * 【詳細説明】
 * - recovery latchは将来のproduction dispatcher側で送信前に再評価するが、debug panelでも同じ危険境界を人間に見せる。
 * - commandIdやquarantineReasonが欠けても文言shapeを崩さず、未指定部分は省略して表示する。
 *
 * @private
 * @function normalizeRecoveryBlockerForPanel
 * @param {object|null|undefined} recoveryBlocker - 復旧ラッチblocker判定
 * @returns {{blocked:boolean, reason:string, commandId:string, quarantineReason:string, detail:string, commandKind:string, deviceId:string, sessionId:string, materialSourceId:string, status:string, sentAt:string, recordDigest:string, operatorResolvable:boolean}} 表示用blocker
 */
function normalizeRecoveryBlockerForPanel(recoveryBlocker) {
  const blocked = recoveryBlocker?.blocked === true;
  const reason = toText(recoveryBlocker?.reason, blocked ? "blocked" : "clear");
  const commandId = toText(recoveryBlocker?.commandId, "");
  const quarantineReason = toText(recoveryBlocker?.quarantineReason, "");
  const suffix = [reason, commandId, quarantineReason].filter(Boolean).join(" / ");
  return {
    blocked,
    reason,
    commandId,
    quarantineReason,
    commandKind: toText(recoveryBlocker?.commandKind, ""),
    deviceId: toText(recoveryBlocker?.deviceId, ""),
    sessionId: toText(recoveryBlocker?.sessionId, ""),
    materialSourceId: toText(recoveryBlocker?.materialSourceId, ""),
    status: toText(recoveryBlocker?.status, ""),
    sentAt: toText(recoveryBlocker?.sentAt, ""),
    recordDigest: toText(recoveryBlocker?.recordDigest, ""),
    operatorResolvable: recoveryBlocker?.operatorResolvable === true,
    detail: blocked ? `復旧確認待ち: ${suffix}` : "未解決の復旧ラッチなし",
  };
}

/**
 * Preflight項目を生成する。
 *
 * 【詳細説明】
 * - Certification UIは送信直前authorityではないが、何がNGでLIVE送信不可かを明示するため同じ観点を表示する。
 *
 * @private
 * @param {object} options - preflight生成オプション
 * @param {object} options.printer - printer情報
 * @param {object} options.materialViewModel - material view model
 * @param {object|null} options.targetSource - 対象source
 * @param {string} options.certificationStatus - certification状態
 * @param {object} options.execution - 実行状態
 * @param {object} options.recoveryBlocker - 復旧ラッチblocker表示
 * @returns {Array<object>} preflight行一覧
 */
function createPreflightItems({ printer, materialViewModel, targetSource, certificationStatus, execution, recoveryBlocker }) {
  const topologyState = toText(materialViewModel?.summary?.topologyState, "unobserved");
  const printerIdle = createPrinterIdlePreflightDetail(printer);
  const selectedState = targetSource?.selected === true ? "ok" : "warn";
  const selectionEvidence = createSelectionEvidencePreflightDetail(materialViewModel);
  return [
    {
      key: "active-session",
      label: "Active session",
      state: isTrue(printer?.active) && Boolean(printer?.deviceId) && Boolean(printer?.sessionId) ? "ok" : "fail",
      detail: printer?.sessionId ? `session ${printer.sessionId}` : "session未確立",
    },
    {
      key: "topology-fresh",
      label: "Topology fresh",
      state: topologyState === "fresh" ? "ok" : "fail",
      detail: topologyState === "fresh" ? "現在観測" : `現在は${topologyState}`,
    },
    {
      key: "printer-idle",
      label: "Printer idle",
      state: printerIdle.state,
      detail: printerIdle.detail,
    },
    {
      key: "target-loaded",
      label: "Target loaded",
      state: targetSource?.presence === "loaded" ? "ok" : "fail",
      detail: targetSource?.displaySlot ? `${targetSource.displaySlot} ${targetSource.presence || "unknown"}` : "対象slot未選択",
    },
    {
      key: "selected-source",
      label: "Selected source",
      state: selectedState,
      detail: targetSource?.displaySlot
        ? (targetSource.selected === true ? `機器選択中: ${targetSource.displaySlot}` : `${targetSource.displaySlot} は機器未選択`)
        : "選択source未観測",
    },
    {
      key: "selection-complete",
      label: "Selection evidence",
      state: selectionEvidence.state,
      detail: selectionEvidence.detail,
    },
    {
      key: "certification-status",
      label: "Certification status",
      state: certificationStatus === "certified" ? "ok" : "fail",
      detail: certificationStatus === "certified" ? "実機証跡登録済み" : "未認証",
    },
    {
      key: "recovery-blocker",
      label: "Recovery blocker",
      state: recoveryBlocker?.blocked === true ? "fail" : "ok",
      detail: recoveryBlocker?.detail || "未解決の復旧ラッチなし",
    },
    {
      key: "mutex-available",
      label: "Printer mutex",
      state: execution?.mutexOwner ? "fail" : "ok",
      detail: execution?.mutexOwner ? `使用中: ${execution.mutexOwner}` : "利用可能",
    },
  ];
}

/**
 * armが現在snapshotに対して有効か判定する。
 *
 * 【詳細説明】
 * - armはdeviceId/sessionId/sourceId/commandKindへ束縛し、sessionやsourceが変わった後の誤送信を防ぐ。
 *
 * @private
 * @param {object} arm - arm状態
 * @param {object} printer - printer情報
 * @param {object|null} targetSource - 対象source
 * @param {string} commandKind - command kind
 * @param {number=} nowMs - 現在時刻のepoch milliseconds
 * @returns {{valid: boolean, reason: string}} 判定結果
 */
function validateArmBinding(arm, printer, targetSource, commandKind, nowMs = Date.now()) {
  if (!isTrue(arm?.armed)) {
    return { valid: false, reason: "未ARM" };
  }
  const mismatches = [];
  if (toText(arm.boundDeviceId) !== toText(printer?.deviceId)) {
    mismatches.push("device");
  }
  if (toText(arm.boundSessionId) !== toText(printer?.sessionId)) {
    mismatches.push("session");
  }
  if (toText(arm.boundSourceId) !== toText(targetSource?.sourceId)) {
    mismatches.push("source");
  }
  if (toText(arm.boundCommandKind) !== commandKind) {
    mismatches.push("command");
  }
  if (mismatches.length > 0) {
    return { valid: false, reason: `${mismatches.join("/") }変更` };
  }
  const expiresAtMs = Date.parse(arm.expiresAt || "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return { valid: false, reason: "ARM期限切れ" };
  }
  return { valid: true, reason: "ARM有効" };
}

/**
 * dry-run planが現在対象source/commandと一致するか判定する。
 *
 * 【詳細説明】
 * - ViewModel生成時点でdry-runが成功していても、command kindやsourceIdが現在のtargetと違うplanはLIVE送信候補にしない。
 *
 * @private
 * @function validateDryRunPlan
 * @param {object|null|undefined} dryRunPlan - dry-run transport plan
 * @param {string} commandKind - 現在のcommand kind
 * @param {object|null|undefined} targetSource - 現在対象source
 * @returns {{valid: boolean, status: string, reason: string}} dry-run整合性
 */
function validateDryRunPlan(dryRunPlan, commandKind, targetSource) {
  if (!dryRunPlan || dryRunPlan.ok !== true) {
    return {
      valid: false,
      status: "rejected",
      reason: dryRunPlan?.reason || "dry-run-plan-rejected",
    };
  }
  const planCommandKind = toText(dryRunPlan.details?.commandKind);
  const planSourceId = toText(dryRunPlan.details?.sourceId);
  const missing = [];
  if (!planCommandKind) {
    missing.push("command");
  }
  if (!planSourceId) {
    missing.push("source");
  }
  if (missing.length > 0) {
    return {
      valid: false,
      status: "missing",
      reason: `dry-run-${missing.join("/")}-missing`,
    };
  }
  const mismatches = [];
  if (planCommandKind !== commandKind) {
    mismatches.push("command");
  }
  if (planSourceId !== toText(targetSource?.sourceId)) {
    mismatches.push("source");
  }
  if (mismatches.length > 0) {
    return {
      valid: false,
      status: "mismatch",
      reason: `dry-run-${mismatches.join("/")}-mismatch`,
    };
  }
  return {
    valid: true,
    status: "ok",
    reason: "dry-run-ok",
  };
}

/**
 * LIVE送信の有効化可否と無効理由を生成する。
 *
 * 【詳細説明】
 * - disabled tooltipが`dry-run-ok`のような正常理由にならないよう、ARM、dry-run、preflight、認証の順に
 *   実際にブロックしている理由だけを返す。
 * - preflightのwarnは原則blockingとし、実機semantics待ちのselected-sourceだけ診断情報として扱う。
 * - unknown/submitted/post-observedなどの未解決executionは、物理結果の人間確認まで再送信をhard disableする。
 *
 * @private
 * @function createLiveSendReadiness
 * @param {Array<object>} preflight - preflight行一覧
 * @param {{valid: boolean, reason: string}} armBinding - ARM判定結果
 * @param {{valid: boolean, reason: string}} dryRunValidation - dry-run判定結果
 * @param {string} certificationStatus - certification状態
 * @param {object=} execution - 実行状態
 * @returns {{enabled: boolean, reason: string}} LIVE送信readiness
 */
function createLiveSendReadiness(preflight, armBinding, dryRunValidation, certificationStatus, execution = {}) {
  const executionStatus = toText(execution?.status, "idle");
  if (["running", "submitting", "submitted", "sent", "probing", "post-observed", "unknown", "timeout"].includes(executionStatus)) {
    return { enabled: false, reason: `execution-unresolved:${executionStatus}` };
  }
  if (!armBinding.valid) {
    return { enabled: false, reason: armBinding.reason };
  }
  if (!dryRunValidation.valid) {
    return { enabled: false, reason: dryRunValidation.reason };
  }
  if (certificationStatus !== "certified") {
    return { enabled: false, reason: "certification-uncertified" };
  }
  const blockingPreflightKeys = (Array.isArray(preflight) ? preflight : [])
    .filter((item) => item?.key !== "certification-status")
    .filter((item) => item?.state === "fail" || (item?.state !== "ok" && item?.key !== "selected-source"))
    .map((item) => item.key || item.label || "unknown")
    .filter(Boolean);
  if (blockingPreflightKeys.length > 0) {
    return {
      enabled: false,
      reason: `preflight-failed:${blockingPreflightKeys.join(",")}`,
    };
  }
  return { enabled: true, reason: "ready" };
}

/**
 * 実行状態を利用者向けに整形する。
 *
 * 【詳細説明】
 * - `submitted` と `post-observed` は成功ではなく、物理状態確認待ちとして表示する。
 *
 * @private
 * @param {object|null|undefined} execution - command実行状態
 * @returns {string} 実行状態表示
 */
function formatExecutionStatus(execution) {
  const status = toText(execution?.status, "idle");
  if (status === "submitted" || status === "sent") {
    return "送信済み / 物理確認待ち";
  }
  if (status === "post-observed") {
    return "観測済み / 物理確認待ち";
  }
  if (status === "unknown") {
    return "結果不明 / 物理確認が必要";
  }
  if (status === "timeout") {
    return "timeout / 結果不明";
  }
  if (status === "failed" || status === "error" || status === "rejected") {
    return "失敗";
  }
  if (status === "confirmed" || status === "completed") {
    return "確認済み";
  }
  return "待機中";
}

/**
 * evidence timelineを生成する。
 *
 * 【詳細説明】
 * - operator markerやbefore/after boxsInfoを同じ時系列へ置き、後からfixture化しやすい形で保持する。
 *
 * @private
 * @param {object} evidence - evidence入力
 * @param {object} execution - command実行状態
 * @returns {Array<object>} timeline行一覧
 */
function createEvidenceTimeline(evidence = {}, execution = {}) {
  const rows = [];
  for (const [key, label] of [
    ["beforeBoxsInfo", "before boxsInfo"],
    ["operatorArm", "operator arm"],
    ["outbound", "outbound"],
    ["transportResponse", "transport response"],
    ["afterBoxsInfo", "after boxsInfo"],
    ["expectedState", "expected-state"],
    ["confirmation", "operator observation"],
  ]) {
    if (evidence[key]) {
      rows.push({
        key,
        label,
        status: "recorded",
        observedAt: evidence[key]?.observedAt || evidence[key]?.createdAt || null,
      });
    }
  }
  const executionStatus = formatExecutionStatus(execution);
  if (executionStatus !== "待機中") {
    rows.push({
      key: "execution",
      label: executionStatus,
      status: execution?.status || "unknown",
      observedAt: execution?.completedAt || execution?.startedAt || null,
    });
  }
  if (Array.isArray(evidence.operatorMarkers)) {
    for (const marker of evidence.operatorMarkers) {
      rows.push({
        key: `operator:${marker?.name || rows.length}`,
        label: `operator marker: ${toText(marker?.name, "unknown")}`,
        status: "recorded",
        observedAt: marker?.observedAt || marker?.createdAt || null,
      });
    }
  }
  return rows.length > 0 ? rows : [{
    key: "empty",
    label: "証跡未記録",
    status: "empty",
    observedAt: null,
  }];
}

/**
 * CFS Certification パネル用ViewModelを生成する。
 *
 * 【詳細説明】
 * - 通常フィラメントカードのMaterialTopology ViewModelを入力として、選択対象、dry-run plan、preflight、
 *   live arm判定、evidence timelineを一つの表示snapshotへ束ねる。
 * - ここで生成する `liveSend.enabled` は表示用であり、production送信時には別途send-time再検証が必要になる。
 *
 * @function createCfsCertificationPanelViewModel
 * @param {object=} options - ViewModel生成オプション
 * @param {object=} options.printer - printer/session情報
 * @param {object=} options.materialViewModel - material topology view model
 * @param {object=} options.targetSource - 明示対象source
 * @param {object=} options.command - command表示情報
 * @param {object=} options.dryRunPlan - dry-run transport plan
 * @param {object=} options.arm - live arm状態
 * @param {object=} options.evidence - evidence入力
 * @param {object=} options.execution - command実行状態
 * @param {object=} options.recoveryBlocker - 復旧ラッチblocker判定
 * @param {number=} options.nowMs - ARM期限判定に使う現在時刻のepoch milliseconds
 * @returns {object} Certificationパネル用ViewModel
 * @example
 * const vm = createCfsCertificationPanelViewModel({ printer, materialViewModel });
 */
export function createCfsCertificationPanelViewModel(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const printer = {
    displayName: toText(options.printer?.displayName, "--"),
    model: toText(options.printer?.model, "--"),
    firmwareVersion: toText(options.printer?.firmwareVersion, ""),
    deviceId: toText(options.printer?.deviceId),
    sessionId: toText(options.printer?.sessionId),
    transportKind: toText(options.printer?.transportKind, "ws9999"),
    active: isTrue(options.printer?.active),
    state: toText(options.printer?.state || options.printer?.printState, ""),
    statusProbeStatus: toText(options.printer?.statusProbeStatus || options.printer?.printStatusProbeStatus, ""),
    printActivityState: toText(options.printer?.printActivityState || options.printer?.activityState, ""),
    coreStateComplete: options.printer?.coreStateComplete ?? options.printer?.printCoreStateComplete ?? null,
    printerIdleObservation: options.printer?.printerIdleObservation &&
      typeof options.printer.printerIdleObservation === "object"
      ? { ...options.printer.printerIdleObservation }
      : null,
  };
  const materialViewModel = options.materialViewModel || {};
  const targetSource = resolveTargetSource(materialViewModel, options.targetSource);
  const commandKind = toText(options.command?.commandKind, DEFAULT_COMMAND_KIND);
  const dryRunPlan = options.dryRunPlan || null;
  const dryRunValidation = validateDryRunPlan(dryRunPlan, commandKind, targetSource);
  const dryRunStatus = dryRunValidation.status;
  const certificationStatus = toText(
    options.command?.certificationStatus ||
    dryRunPlan?.details?.semanticStatus,
    "uncertified"
  );
  const execution = options.execution || {};
  const recoveryBlocker = normalizeRecoveryBlockerForPanel(options.recoveryBlocker);
  const preflight = createPreflightItems({
    printer,
    materialViewModel,
    targetSource,
    certificationStatus,
    execution,
    recoveryBlocker,
  });
  const arm = {
    armed: isTrue(options.arm?.armed),
    armedAt: options.arm?.armedAt || null,
    expiresAt: options.arm?.expiresAt || null,
    boundDeviceId: toText(options.arm?.boundDeviceId),
    boundSessionId: toText(options.arm?.boundSessionId),
    boundSourceId: toText(options.arm?.boundSourceId),
    boundCommandKind: toText(options.arm?.boundCommandKind),
  };
  const armBinding = validateArmBinding(arm, printer, targetSource, commandKind, nowMs);
  const liveSend = createLiveSendReadiness(preflight, armBinding, dryRunValidation, certificationStatus, execution);
  return {
    schemaVersion: CFS_CERTIFICATION_PANEL_SCHEMA_VERSION,
    panel: CERTIFICATION_PANEL_NAME,
    generatedAt: new Date().toISOString(),
    printer,
    material: {
      topologyState: toText(materialViewModel?.summary?.topologyState, "unobserved"),
      observedAt: materialViewModel?.observation?.lastObservedAt || null,
      targetSource: targetSource ? {
        sourceId: targetSource.sourceId,
        displaySlot: targetSource.displaySlot,
        kind: targetSource.kind,
        presence: targetSource.presence,
        selected: targetSource.selected === true,
        material: cloneJson(targetSource.material),
        assignments: cloneJson(targetSource.assignments) || [],
        remainingText: formatRemaining(targetSource),
      } : null,
      summary: cloneJson(materialViewModel?.summary) || {},
    },
    command: {
      commandKind,
      sourceId: targetSource?.sourceId || "",
      displaySlot: targetSource?.displaySlot || "--",
      assignmentLabel: formatAssignment(targetSource),
      materialLabel: formatMaterial(targetSource),
      sideEffect: true,
      idempotent: false,
      retryAllowed: false,
      certificationStatus,
    },
    dryRun: {
      status: dryRunStatus,
      reason: dryRunValidation.reason,
      plan: cloneJson(dryRunPlan),
      payloadPreview: cloneJson(dryRunPlan?.frames || dryRunPlan?.payloadPreview || []),
    },
    preflight,
    recoveryBlocker,
    arm: {
      ...arm,
      valid: armBinding.valid,
      reason: armBinding.reason,
    },
    liveSend: {
      enabled: liveSend.enabled,
      reason: liveSend.reason,
    },
    execution: {
      status: toText(execution.status, "idle"),
      displayStatus: formatExecutionStatus(execution),
      startedAt: execution.startedAt || null,
      completedAt: execution.completedAt || null,
      timedOut: isTrue(execution.timedOut) || execution.status === "timeout",
      retryAllowed: false,
      mutexOwner: execution.mutexOwner || null,
    },
    evidence: {
      timeline: createEvidenceTimeline(options.evidence, execution),
      raw: cloneJson(options.evidence || {}),
      probeSummaries: {
        before: extractProbeSummaryForExport(options.evidence?.beforeBoxsInfo),
        after: extractProbeSummaryForExport(options.evidence?.afterBoxsInfo),
      },
    },
    export: {
      captureId: toText(options.export?.captureId, ""),
      fixtureId: toText(options.export?.fixtureId, ""),
      sessionCorrelationSalt: toText(options.export?.sessionCorrelationSalt, ""),
      jsonAvailable: true,
      ndjsonAvailable: true,
      zipAvailable: false,
      redactionApplied: true,
      eventCount: Array.isArray(options.evidence?.events) ? options.evidence.events.length : 0,
    },
  };
}

/**
 * boxsInfo probe summaryをexport向けに抽出する。
 *
 * 【詳細説明】
 * - raw evidence全体は別枠で保持しつつ、reviewerがsource差分だけを読めるsummaryを作る。
 * - observedAtはprobe本体の時刻を採用し、summary内のprotocol情報と観測時刻を同じ単位で確認できるようにする。
 *
 * @private
 * @function extractProbeSummaryForExport
 * @param {object|null|undefined} probe - before/after boxsInfo probe evidence
 * @returns {object|null} export用probe summary、またはnull
 */
function extractProbeSummaryForExport(probe) {
  if (!probe?.summary || typeof probe.summary !== "object") {
    return null;
  }
  return {
    ...cloneJson(probe.summary),
    observedAt: probe.observedAt || probe.createdAt || null,
  };
}

/**
 * probe summaryからselected source表示を生成する。
 *
 * 【詳細説明】
 * - selectedSourceIdsは複数あり得るため、空なら未観測、複数ならカンマ区切りで表示する。
 *
 * @private
 * @function formatProbeSelectedSources
 * @param {object|null|undefined} probeSummary - probe summary
 * @returns {string} selected source表示
 */
function formatProbeSelectedSources(probeSummary) {
  const ids = Array.isArray(probeSummary?.selectedSourceIds) ? probeSummary.selectedSourceIds : [];
  return ids.length > 0 ? ids.join(", ") : "--";
}

/**
 * probe summaryからtarget source表示を生成する。
 *
 * 【詳細説明】
 * - targetSourceはCLIで指定したsourceに対応する観測summaryであり、slot表示とsourceIdを併記する。
 *
 * @private
 * @function formatProbeTargetSource
 * @param {object|null|undefined} probeSummary - probe summary
 * @returns {string} target source表示
 */
function formatProbeTargetSource(probeSummary) {
  const targetSource = probeSummary?.targetSource || null;
  if (!targetSource) {
    return "--";
  }
  return [
    toText(targetSource.displaySlot, "--"),
    toText(targetSource.sourceId, "--"),
  ].join(" / ");
}

/**
 * CFS Certification パネルの証跡export bundleを生成する。
 *
 * 【詳細説明】
 * - reviewerへ貼り付けるsummaryと、将来fixtureへ落とすためのJSON/NDJSON素材を同じ構造から作る。
 *
 * @function createCfsCertificationExportBundle
 * @param {object} viewModel - Certificationパネル用ViewModel
 * @returns {object} export bundle
 * @example
 * const bundle = createCfsCertificationExportBundle(viewModel);
 */
export function createCfsCertificationExportBundle(viewModel) {
  const rawEvidence = cloneJson(viewModel?.evidence?.raw) || {};
  const protocolEvents = Array.isArray(rawEvidence.events) ? rawEvidence.events : [];
  const sessionCorrelation = createCfsSessionCorrelationEvidence(viewModel?.printer?.sessionId, {
    salt: viewModel?.export?.sessionCorrelationSalt,
  });
  const probeSummaries = {
    before: extractProbeSummaryForExport(rawEvidence.beforeBoxsInfo),
    after: extractProbeSummaryForExport(rawEvidence.afterBoxsInfo),
  };
  const bundle = {
    manifest: {
      panel: CERTIFICATION_PANEL_NAME,
      schemaVersion: CFS_CERTIFICATION_PANEL_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      printer: cloneJson(viewModel?.printer) || {},
      captureId: viewModel?.export?.captureId || "",
      fixtureId: viewModel?.export?.fixtureId || "",
      sourceId: viewModel?.command?.sourceId || "",
      displaySlot: viewModel?.command?.displaySlot || "",
      commandKind: viewModel?.command?.commandKind || "",
      sessionCorrelation,
      dryRunStatus: viewModel?.dryRun?.status || "unknown",
      liveSendEnabled: viewModel?.liveSend?.enabled === true,
      redactionApplied: false,
    },
    summary: {
      material: cloneJson(viewModel?.material) || {},
      command: cloneJson(viewModel?.command) || {},
      preflight: cloneJson(viewModel?.preflight) || [],
      recoveryBlocker: cloneJson(viewModel?.recoveryBlocker) || {},
      arm: cloneJson(viewModel?.arm) || {},
      execution: cloneJson(viewModel?.execution) || {},
      probeSummaries,
    },
    dryRunPlan: cloneJson(viewModel?.dryRun?.plan) || null,
    evidence: rawEvidence,
    events: cloneJson(protocolEvents) || [],
    summaryTimeline: cloneJson(viewModel?.evidence?.timeline) || [],
  };
  const redactedBundle = redactProtocolValue(bundle);
  const redacted = replaceKnownSessionText(
    redactedBundle,
    viewModel?.printer?.sessionId,
    redactedBundle?.manifest?.printer?.sessionId
  );
  redacted.manifest = {
    ...(redacted.manifest || {}),
    redactionApplied: true,
  };
  return redacted;
}

/**
 * 指定tag/classのDOM要素を生成する。
 *
 * 【詳細説明】
 * - パネルrenderer内でDOM APIだけを使い、HTML文字列連結による注入を避ける。
 *
 * @private
 * @param {Document} documentRef - DOM document
 * @param {string} tagName - tag名
 * @param {string=} className - className
 * @param {string=} text - textContent
 * @returns {HTMLElement} 生成要素
 */
function createElement(documentRef, tagName, className = "", text = "") {
  const element = documentRef.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text) {
    element.textContent = text;
  }
  return element;
}

/**
 * key-value行をsectionへ追加する。
 *
 * 【詳細説明】
 * - meta表示の構造を統一し、CSSだけで密度を調整できるようにする。
 *
 * @private
 * @param {HTMLElement} parent - 追加先
 * @param {string} label - ラベル
 * @param {string} value - 値
 * @returns {HTMLElement} 生成行
 */
function appendKeyValue(parent, label, value) {
  const row = createElement(parent.ownerDocument, "div", "fc-kv");
  row.appendChild(createElement(parent.ownerDocument, "span", "fc-kv-label", label));
  row.appendChild(createElement(parent.ownerDocument, "span", "fc-kv-value", value));
  parent.appendChild(row);
  return row;
}

/**
 * section DOMを生成する。
 *
 * 【詳細説明】
 * - reviewer案の区切りをそのまま見出し化し、通常監視UIとの役割差を明確にする。
 *
 * @private
 * @param {HTMLElement} parent - 追加先
 * @param {string} title - section見出し
 * @returns {HTMLElement} section body
 */
function appendSection(parent, title) {
  const section = createElement(parent.ownerDocument, "section", "fc-section");
  section.appendChild(createElement(parent.ownerDocument, "h3", "fc-section-title", title));
  const body = createElement(parent.ownerDocument, "div", "fc-section-body");
  section.appendChild(body);
  parent.appendChild(section);
  return body;
}

/**
 * preflight項目をDOMへ描画する。
 *
 * 【詳細説明】
 * - fail/warn/okを短いbadgeで表示し、なぜLIVE送信できないかを一覧できるようにする。
 *
 * @private
 * @param {HTMLElement} parent - 追加先
 * @param {Array<object>} items - preflight項目
 * @returns {void}
 */
function renderPreflight(parent, items) {
  const list = createElement(parent.ownerDocument, "div", "fc-preflight-list");
  for (const item of items) {
    const row = createElement(parent.ownerDocument, "div", `fc-preflight-row fc-preflight-${item.state}`);
    row.appendChild(createElement(parent.ownerDocument, "span", "fc-preflight-label", item.label));
    row.appendChild(createElement(parent.ownerDocument, "span", "fc-preflight-state", item.state.toUpperCase()));
    row.appendChild(createElement(parent.ownerDocument, "span", "fc-preflight-detail", item.detail));
    list.appendChild(row);
  }
  parent.appendChild(list);
}

/**
 * payload previewをDOMへ描画する。
 *
 * 【詳細説明】
 * - frame shapeはレビューや実機横検証で重要なので、折り返し可能なpre要素で表示する。
 *
 * @private
 * @param {HTMLElement} parent - 追加先
 * @param {*} payload - 表示対象payload
 * @returns {void}
 */
function renderPayloadPreview(parent, payload) {
  const pre = createElement(parent.ownerDocument, "pre", "fc-payload-preview");
  pre.textContent = JSON.stringify(payload || [], null, 2);
  parent.appendChild(pre);
}

/**
 * evidence timelineをDOMへ描画する。
 *
 * 【詳細説明】
 * - submittedを成功色にせず、物理確認待ちの行として扱う。
 *
 * @private
 * @param {HTMLElement} parent - 追加先
 * @param {Array<object>} timeline - timeline行
 * @returns {void}
 */
function renderEvidenceTimeline(parent, timeline) {
  const list = createElement(parent.ownerDocument, "ol", "fc-timeline");
  for (const item of timeline) {
    const row = createElement(parent.ownerDocument, "li", `fc-timeline-row fc-timeline-${item.status || "unknown"}`);
    row.appendChild(createElement(parent.ownerDocument, "span", "fc-timeline-label", item.label));
    row.appendChild(createElement(parent.ownerDocument, "span", "fc-timeline-time", formatLocalDateTime(item.observedAt)));
    list.appendChild(row);
  }
  parent.appendChild(list);
}

/**
 * CFS Certification パネルViewModelをDOMへ描画する。
 *
 * 【詳細説明】
 * - 通常フィラメントカードではなく、危険操作のcertificationと証跡収集に特化した広いパネルを描画する。
 * - `liveSend.enabled` がtrueでない限りLIVE送信ボタンはdisabledにし、click handlerも呼ばない。
 *
 * @function renderCfsCertificationPanel
 * @param {HTMLElement} container - 描画先
 * @param {object} viewModel - Certificationパネル用ViewModel
 * @param {object=} options - rendererオプション
 * @param {Function=} options.onProbeBoxsInfo - boxsInfo read-only probe handler
 * @param {Function=} options.onProbeInfo - /info read-only probe handler
 * @param {Function=} options.onLiveSend - LIVE送信handler
 * @param {Function=} options.onResolveRecoveryBlocker - operator確認済み復旧ラッチ解決handler
 * @param {Function=} options.onExport - export handler
 * @returns {object} renderer handle
 * @example
 * const handle = renderCfsCertificationPanel(container, viewModel);
 */
export function renderCfsCertificationPanel(container, viewModel, options = {}) {
  if (!container || typeof container.replaceChildren !== "function") {
    throw new TypeError("renderCfsCertificationPanel requires a DOM container.");
  }
  const documentRef = container.ownerDocument || document;
  container.replaceChildren();
  container.classList.add("fc-root");

  const header = createElement(documentRef, "div", "fc-header");
  const titleBlock = createElement(documentRef, "div", "fc-title-block");
  titleBlock.appendChild(createElement(documentRef, "div", "fc-title", "CFS Debug / Certification"));
  titleBlock.appendChild(createElement(
    documentRef,
    "div",
    "fc-subtitle",
    `${viewModel.printer.displayName} / ${viewModel.printer.model}`
  ));
  header.appendChild(titleBlock);
  header.appendChild(createElement(documentRef, "div", "fc-status-pill", viewModel.liveSend.enabled ? "LIVE可" : "LIVE無効"));
  container.appendChild(header);

  const warning = createElement(
    documentRef,
    "div",
    "fc-warning",
    "LIVE SIDE EFFECT: 実機certification前の物理操作は無効です。送信済みは成功ではなく、必ず物理確認待ちとして扱います。"
  );
  container.appendChild(warning);

  const grid = createElement(documentRef, "div", "fc-grid");
  container.appendChild(grid);

  const probeSection = appendSection(grid, "Read-only Probe");
  appendKeyValue(probeSection, "Transport", viewModel.printer.transportKind);
  appendKeyValue(probeSection, "Session", viewModel.printer.sessionId || "--");
  appendKeyValue(probeSection, "最終観測", formatLocalDateTime(viewModel.material.observedAt));
  const probeActions = createElement(documentRef, "div", "fc-actions");
  const boxsButton = createElement(documentRef, "button", "fc-button", "boxsInfo取得");
  boxsButton.type = "button";
  boxsButton.disabled = typeof options.onProbeBoxsInfo !== "function";
  boxsButton.addEventListener("click", () => options.onProbeBoxsInfo?.(viewModel));
  const infoButton = createElement(documentRef, "button", "fc-button", "/info取得");
  infoButton.type = "button";
  infoButton.disabled = typeof options.onProbeInfo !== "function";
  infoButton.addEventListener("click", () => options.onProbeInfo?.(viewModel));
  probeActions.appendChild(boxsButton);
  probeActions.appendChild(infoButton);
  probeSection.appendChild(probeActions);

  const probeSummary = viewModel.evidence?.probeSummaries || {};
  if (probeSummary.before || probeSummary.after) {
    const probeSummarySection = appendSection(grid, "Probe summary");
    if (probeSummary.before) {
      appendKeyValue(probeSummarySection, "before selected", formatProbeSelectedSources(probeSummary.before));
      appendKeyValue(probeSummarySection, "before target", formatProbeTargetSource(probeSummary.before));
      appendKeyValue(probeSummarySection, "before loaded", String(probeSummary.before.loadedSourceCount ?? "--"));
    }
    if (probeSummary.after) {
      appendKeyValue(probeSummarySection, "after selected", formatProbeSelectedSources(probeSummary.after));
      appendKeyValue(probeSummarySection, "after target", formatProbeTargetSource(probeSummary.after));
      appendKeyValue(probeSummarySection, "after loaded", String(probeSummary.after.loadedSourceCount ?? "--"));
    }
  }

  const preflightSection = appendSection(grid, "Preflight");
  renderPreflight(preflightSection, viewModel.preflight);

  if (viewModel.recoveryBlocker?.blocked === true) {
    const recoverySection = appendSection(grid, "復旧確認");
    appendKeyValue(recoverySection, "状態", viewModel.recoveryBlocker.detail);
    appendKeyValue(recoverySection, "Command", viewModel.recoveryBlocker.commandKind || "--");
    appendKeyValue(recoverySection, "Source", viewModel.recoveryBlocker.materialSourceId || "--");
    appendKeyValue(recoverySection, "Device", viewModel.recoveryBlocker.deviceId || "--");
    appendKeyValue(recoverySection, "Session", viewModel.recoveryBlocker.sessionId || "--");
    appendKeyValue(recoverySection, "Status", viewModel.recoveryBlocker.status || "--");
    appendKeyValue(recoverySection, "Sent", formatLocalDateTime(viewModel.recoveryBlocker.sentAt));
    appendKeyValue(recoverySection, "Digest", viewModel.recoveryBlocker.recordDigest || "--");
    const canResolveByOperator = viewModel.recoveryBlocker.reason === "unresolved-recovery"
      && Boolean(viewModel.recoveryBlocker.commandId)
      && viewModel.recoveryBlocker.operatorResolvable === true
      && typeof options.onResolveRecoveryBlocker === "function";
    const recoveryActions = createElement(documentRef, "div", "fc-actions");
    const resolveButton = createElement(documentRef, "button", "fc-button", "物理確認済みとして解除");
    resolveButton.type = "button";
    resolveButton.dataset.action = "resolve-recovery-blocker";
    resolveButton.disabled = !canResolveByOperator;
    resolveButton.title = canResolveByOperator
      ? "プリンタ本体の物理状態を確認済みとして、この未解決ラッチを解決済みにします"
      : "conflict/quarantineは自動または通常のoperator確認では解除できません";
    resolveButton.addEventListener("click", () => {
      if (!canResolveByOperator) {
        return;
      }
      options.onResolveRecoveryBlocker({
        commandId: viewModel.recoveryBlocker.commandId,
        resolution: "operator-cleared",
        expectedDeviceId: viewModel.recoveryBlocker.deviceId,
        expectedDigest: viewModel.recoveryBlocker.recordDigest,
        expectedCommandKind: viewModel.recoveryBlocker.commandKind,
        expectedMaterialSourceId: viewModel.recoveryBlocker.materialSourceId,
        resolutionSource: "cfs-certification-panel",
        operatorAcknowledged: true,
        panelDeviceId: viewModel.printer?.deviceId || "",
        viewModel,
      });
    });
    recoveryActions.appendChild(resolveButton);
    recoverySection.appendChild(recoveryActions);
  }

  const dryRunSection = appendSection(grid, "Dry-run");
  appendKeyValue(dryRunSection, "Command", viewModel.command.commandKind);
  appendKeyValue(dryRunSection, "Target", `${viewModel.command.displaySlot} / ${viewModel.command.sourceId || "--"}`);
  appendKeyValue(dryRunSection, "Material", viewModel.command.materialLabel);
  appendKeyValue(dryRunSection, "Assignment", viewModel.command.assignmentLabel);
  appendKeyValue(dryRunSection, "Plan", `${viewModel.dryRun.status} / ${viewModel.command.certificationStatus}`);
  renderPayloadPreview(dryRunSection, viewModel.dryRun.payloadPreview);

  const armSection = appendSection(grid, "Live Arm");
  appendKeyValue(armSection, "ARM", viewModel.arm.valid ? "ARM有効" : `ARM無効: ${viewModel.arm.reason}`);
  appendKeyValue(armSection, "Bound", [
    viewModel.arm.boundDeviceId || "--",
    viewModel.arm.boundSessionId || "--",
    viewModel.arm.boundSourceId || "--",
    viewModel.arm.boundCommandKind || "--",
  ].join(" / "));
  appendKeyValue(armSection, "Retry", "自動再試行: 無効");
  const liveButton = createElement(documentRef, "button", "fc-button fc-live-button", "LIVE SEND");
  liveButton.type = "button";
  liveButton.dataset.action = "live-send";
  liveButton.disabled = viewModel.liveSend.enabled !== true || typeof options.onLiveSend !== "function";
  liveButton.title = liveButton.disabled
    ? `LIVE送信不可: ${viewModel.liveSend.reason}`
    : "現在snapshotへ束縛されたLIVE送信を実行します";
  liveButton.addEventListener("click", () => {
    if (viewModel.liveSend.enabled === true && typeof options.onLiveSend === "function") {
      options.onLiveSend(viewModel);
    }
  });
  armSection.appendChild(liveButton);

  const timelineSection = appendSection(grid, "Evidence timeline");
  renderEvidenceTimeline(timelineSection, viewModel.evidence.timeline);

  const exportSection = appendSection(grid, "証跡エクスポート");
  appendKeyValue(exportSection, "Capture", viewModel.export.captureId || "--");
  appendKeyValue(exportSection, "Events", String(viewModel.export.eventCount));
  const exportActions = createElement(documentRef, "div", "fc-actions");
  for (const [format, label] of [["json", "JSON"], ["ndjson", "NDJSON"], ["zip", "ZIP"]]) {
    const button = createElement(documentRef, "button", "fc-button", label);
    button.type = "button";
    button.dataset.exportFormat = format;
    button.disabled = format === "zip" ? viewModel.export.zipAvailable !== true : typeof options.onExport !== "function";
    button.addEventListener("click", () => {
      if (typeof options.onExport === "function") {
        options.onExport(format, createCfsCertificationExportBundle(viewModel));
      }
    });
    exportActions.appendChild(button);
  }
  exportSection.appendChild(exportActions);

  return Object.freeze({
    /**
     * パネルを新しいViewModelで再描画する。
     *
     * @param {object} nextViewModel - 次のViewModel
     * @returns {void}
     */
    update(nextViewModel) {
      renderCfsCertificationPanel(container, nextViewModel, options);
    },
    /**
     * rendererが保持する状態を破棄する。
     *
     * @returns {void}
     */
    destroy() {
      container.replaceChildren();
      container.classList.remove("fc-root");
    },
  });
}
