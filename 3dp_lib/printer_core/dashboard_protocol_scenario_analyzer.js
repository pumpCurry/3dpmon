/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 protocol scenario analyzer モジュール
 * @file dashboard_protocol_scenario_analyzer.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_protocol_scenario_analyzer
 *
 * 【機能内容サマリ】
 * - ProtocolRecorder fixture の marker / protocol event を scenario 単位で検査
 * - 必須 marker、必須 payload key、capture validation の合否を統合
 * - K2 Pro Combo 物理状態 fixture を read-only で認定するための下地を提供
 *
 * 【公開関数一覧】
 * - {@link analyzeProtocolScenarioFixture}：fixture events と metadata を scenario report へ変換
 * - {@link eventHasPayloadKey}：protocol event が指定 payload key を含むか判定
 *
 * @version 1.390.1314 (PR #432)
 * @since   1.390.1314 (PR #432)
 * @lastModified 2026-08-08 07:47:23
 * -----------------------------------------------------------
 * @todo
 * - K2 printing / paused / resumed / completed の実機 scenario fixture 取得後に標準profileを追加する
 */

"use strict";

/**
 * object が指定 key を自前プロパティとして持つか判定する。
 *
 * 【詳細説明】
 * - fixture payload は実機由来であり prototype を仮定しないため、`hasOwnProperty.call` を使う。
 *
 * @private
 * @param {object|null|undefined} value - 検査対象
 * @param {string} key - 検査する key
 * @returns {boolean} key が存在する場合 true
 */
function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * 配列風の入力を文字列配列へ正規化する。
 *
 * 【詳細説明】
 * - CLI と unit test の両方から渡される値を扱うため、空文字や null を除去して安定化する。
 *
 * @private
 * @param {Array<*>|null|undefined} values - 候補値
 * @returns {string[]} 正規化済み文字列配列
 */
function normalizeStringList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

/**
 * fixture event から JSON payload body を取り出す。
 *
 * 【詳細説明】
 * - WS9999 の `payload.body` と、テスト用の直接 `payload` の両方を許容する。
 * - body が `{ result:{...} }` wrapper の場合も payload key 検査で扱えるように呼び出し側で再帰する。
 *
 * @private
 * @param {object|null|undefined} event - ProtocolRecorder event
 * @returns {object|null} JSON payload body、または null
 */
function extractEventPayloadBody(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.body && typeof payload.body === "object") {
    return payload.body;
  }
  return payload;
}

/**
 * object tree が指定 payload key を含むか再帰的に判定する。
 *
 * 【詳細説明】
 * - Creality firmware は `boxsInfo` を root または `result.boxsInfo` に返すことがあるため、
 *   shallow check だけではなく object tree を探索する。
 *
 * @private
 * @param {*} value - 検査対象
 * @param {string} key - 検査する key
 * @returns {boolean} key が存在する場合 true
 */
function objectTreeHasKey(value, key) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (hasOwn(value, key)) {
    return true;
  }
  return Object.values(value).some((child) => objectTreeHasKey(child, key));
}

/**
 * protocol event が指定 payload key を含むか判定する。
 *
 * 【詳細説明】
 * - marker、transport event、outbound request は payload key 検査の対象外にする。
 * - `boxsInfo` probe を送っただけで scenario evidence と誤判定しないよう、受信 frame だけを扱う。
 * - JSON body 内は再帰的に探索し、wrapper 差異で scenario 判定が壊れないようにする。
 *
 * @function eventHasPayloadKey
 * @param {object|null|undefined} event - ProtocolRecorder event
 * @param {string} key - 検査する payload key
 * @returns {boolean} 指定 key を含む場合 true
 * @example
 * const observed = eventHasPayloadKey(event, "boxsInfo");
 */
export function eventHasPayloadKey(event, key) {
  if (!event || event.direction !== "in") {
    return false;
  }
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    return false;
  }
  return objectTreeHasKey(extractEventPayloadBody(event), normalizedKey);
}

/**
 * marker event を scenario analyzer 用の短い record へ変換する。
 *
 * 【詳細説明】
 * - details は fixture 側で redaction 済みとみなし、source と scheduledAtMs だけを代表値として拾う。
 *
 * @private
 * @param {object} event - marker event
 * @returns {object} marker summary
 */
function summarizeMarker(event) {
  return {
    name: String(event?.name || ""),
    atMs: Number.isFinite(event?.atMs) ? event.atMs : null,
    source: event?.details?.source ?? null,
    scheduledAtMs: Number.isFinite(event?.details?.scheduledAtMs) ? event.details.scheduledAtMs : null,
  };
}

/**
 * 必須 marker の観測状況を集計する。
 *
 * 【詳細説明】
 * - 同じ marker 名を複数回要求する scenario は少ないため、Gate 8 では名前単位の存在検査に限定する。
 * - 順序検査は requiredMarkers の順で最初に見つかった marker index が単調増加することを確認する。
 *
 * @private
 * @param {Array<object>} markers - marker summary 一覧
 * @param {string[]} requiredMarkers - 必須 marker 名一覧
 * @returns {object} marker 判定結果
 */
function analyzeRequiredMarkers(markers, requiredMarkers) {
  const markerNames = markers.map((marker) => marker.name);
  const missing = requiredMarkers.filter((name) => !markerNames.includes(name));
  const matched = requiredMarkers.map((name) => {
    const index = markerNames.indexOf(name);
    return {
      name,
      observed: index >= 0,
      index,
      atMs: index >= 0 ? markers[index].atMs : null,
    };
  });
  const observedIndexes = matched
    .filter((entry) => entry.observed)
    .map((entry) => entry.index);
  const ordered = observedIndexes.every((index, position) => {
    return position === 0 || index > observedIndexes[position - 1];
  });
  return {
    required: requiredMarkers,
    matched,
    missing,
    ordered,
  };
}

/**
 * 必須 payload key の観測状況を集計する。
 *
 * 【詳細説明】
 * - `boxsInfo`、`printProgress`、`state` などの scenario 合格に必要な protocol evidence を
 *   marker とは別に検査する。
 *
 * @private
 * @param {Array<object>} events - ProtocolRecorder event 一覧
 * @param {string[]} requiredPayloadKeys - 必須 payload key 一覧
 * @returns {object} payload key 判定結果
 */
function analyzeRequiredPayloadKeys(events, requiredPayloadKeys) {
  const matched = requiredPayloadKeys.map((key) => {
    const event = events.find((entry) => eventHasPayloadKey(entry, key));
    return {
      key,
      observed: Boolean(event),
      sequence: event?.sequence ?? null,
      atMs: event?.atMs ?? null,
    };
  });
  return {
    required: requiredPayloadKeys,
    matched,
    missing: matched.filter((entry) => !entry.observed).map((entry) => entry.key),
  };
}

/**
 * ProtocolRecorder fixture を scenario report へ変換する。
 *
 * 【詳細説明】
 * - capture CLI の validation と、scenario 固有の marker/payload key 条件を一つの合否にまとめる。
 * - read-only analyzer であり、fixture や実機へ変更は加えない。
 *
 * @function analyzeProtocolScenarioFixture
 * @param {object} fixture - fixture 入力
 * @param {object=} fixture.metadata - `metadata.json` または `capture.metadata`
 * @param {Array<object>=} fixture.events - `events.ndjson` 由来の event 一覧
 * @param {object=} options - 解析オプション
 * @param {string=} options.expectedScenario - 期待する scenario 名
 * @param {boolean=} options.requireValidationSuccess - metadata.validation.success を必須にする場合 true
 * @param {Array<string>=} options.requiredMarkers - 必須 marker 名一覧
 * @param {Array<string>=} options.requiredPayloadKeys - 必須 payload key 一覧
 * @returns {object} scenario 解析結果
 * @example
 * const report = analyzeProtocolScenarioFixture({ metadata, events }, { requiredMarkers: ["operator-print-start"] });
 */
export function analyzeProtocolScenarioFixture(fixture, options = {}) {
  const metadata = fixture?.metadata && typeof fixture.metadata === "object" ? fixture.metadata : {};
  const events = Array.isArray(fixture?.events) ? fixture.events : [];
  const requiredMarkers = normalizeStringList(options.requiredMarkers);
  const requiredPayloadKeys = normalizeStringList(options.requiredPayloadKeys);
  const markers = events
    .filter((event) => event?.direction === "marker" || event?.kind === "marker")
    .map((event) => summarizeMarker(event));
  const markerReport = analyzeRequiredMarkers(markers, requiredMarkers);
  const payloadReport = analyzeRequiredPayloadKeys(events, requiredPayloadKeys);
  const protocolEventCount = events.filter((event) => event?.direction !== "marker").length;
  const failureReasons = [];

  if (options.expectedScenario &&
      metadata.capture?.scenario !== options.expectedScenario) {
    failureReasons.push("scenario-name-mismatch");
  }
  if (options.requireValidationSuccess === true &&
      metadata.validation?.success !== true) {
    failureReasons.push("fixture-validation-failed");
  }
  if (markerReport.missing.length > 0) {
    failureReasons.push("required-marker-missing");
  }
  if (!markerReport.ordered) {
    failureReasons.push("required-marker-order-invalid");
  }
  if (payloadReport.missing.length > 0) {
    failureReasons.push("required-payload-key-missing");
  }

  return {
    schemaVersion: 1,
    success: failureReasons.length === 0,
    failureReasons,
    scenario: metadata.capture?.scenario ?? null,
    eventCount: events.length,
    protocolEventCount,
    markerCount: markers.length,
    markers,
    requiredMarkers: markerReport,
    requiredPayloadKeys: payloadReport,
    validation: {
      success: metadata.validation?.success ?? null,
      failureReasons: Array.isArray(metadata.validation?.failureReasons)
        ? metadata.validation.failureReasons
        : [],
    },
  };
}
