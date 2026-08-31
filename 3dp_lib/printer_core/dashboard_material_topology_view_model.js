/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 material topology view model モジュール
 * @file dashboard_material_topology_view_model.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_topology_view_model
 *
 * 【機能内容サマリ】
 * - Printer Core v3 の read-only material topology を UI 表示用の固定スロット構造へ変換
 * - CFS/CFS-C を4スロット単位で最大4ユニット、外部スプール1本を加えた最大16+1表示へ整形
 * - selected、残量、物理状態、assignment、fresh/staleを表示専用の値としてまとめる
 * - source-aware accounting read model がある場合は、機器観測と3DPmon管理スプール情報を同じ行へ併記
 * - 明示的な command UI candidate hint がある場合だけ、CFS操作UI用の候補権限を表示モデルへ写す
 *
 * 【公開関数一覧】
 * - {@link createMaterialTopologyViewModel}：material topology から表示用 view model を生成
 *
 * @version 1.390.1553 (PR #439)
 * @since   1.390.1361 (PR #432)
 * @lastModified 2026-08-31 19:58:16
 * -----------------------------------------------------------
 * @todo
 * - command authority Gateで、表示slotと安全なCore command contractを接続する
 */

"use strict";

/**
 * Material topology view model の schema version。
 *
 * 【詳細説明】
 * - NormalizedPrinterState の schemaVersion とは分離し、UI 表示用 shape の変更を追跡する。
 *
 * @constant {number}
 */
export const MATERIAL_TOPOLOGY_VIEW_MODEL_SCHEMA_VERSION = 1;

/**
 * CFS/CFS-C 表示で扱う既定のユニット数。
 *
 * 【詳細説明】
 * - CrealityPrint の UI と同じ4スロット単位を保ちつつ、将来の複数CFS構成へ拡張できる上限として4を採用する。
 *
 * @constant {number}
 */
export const DEFAULT_CFS_UNIT_LIMIT = 4;

/**
 * CFS/CFS-C 1ユニットあたりの既定スロット数。
 *
 * 【詳細説明】
 * - 表示は常にA-Dの4枠を持つ。未観測スロットも空行として残し、抜き差しの変化をUIで見失わない。
 *
 * @constant {number}
 */
export const DEFAULT_CFS_SLOTS_PER_UNIT = 4;

/**
 * 外部スプール表示の既定最大数。
 *
 * 【詳細説明】
 * - 現行K2 Pro Combo fixtureでは外部スプールは `id:0,type:1` の1本として観測されるため、標準表示も1本に限定する。
 *
 * @constant {number}
 */
export const DEFAULT_EXTERNAL_SOURCE_LIMIT = 1;

/**
 * CFS slot 表示用ラベル。
 *
 * 【詳細説明】
 * - Unit番号と組み合わせて `1A` から `4D` までを生成する。
 *
 * @constant {string[]}
 */
const SLOT_SUFFIXES = Object.freeze(["A", "B", "C", "D"]);

/**
 * material topology panel で扱うCFS操作action一覧。
 *
 * 【詳細説明】
 * - action名はUI内部名で、command authorityのcommandKindとはrenderer境界で対応付ける。
 *
 * @constant {string[]}
 */
const MATERIAL_CONTROL_ACTIONS = Object.freeze(["select", "load", "unload", "feed", "retract"]);

/**
 * 任意値を有限 number へ変換する。
 *
 * 【詳細説明】
 * - Normalized topology は number/null を期待するが、fixtureや将来providerの揺れに備えて表示境界でも防御する。
 *
 * @private
 * @param {*} value - 数値候補
 * @param {?number=} fallback - 変換不能時の値
 * @returns {?number} 有限 number、または fallback
 */
function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

/**
 * 任意値を boolean/null へ変換する。
 *
 * 【詳細説明】
 * - `selected` などは true/false/null をUIで区別したい。0/1文字列も受け付ける。
 *
 * @private
 * @param {*} value - boolean 候補
 * @returns {?boolean} boolean、または null
 */
function toNullableBoolean(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue === 1 : null;
}

/**
 * ISO日時やepoch msを表示用ISO文字列へ正規化する。
 *
 * 【詳細説明】
 * - ViewModelはDOM描画前の境界なので、日時の妥当性だけを確認してISO文字列へ寄せる。
 * - null/不正値はnullにし、rendererが「未観測」と表示できるようにする。
 *
 * @private
 * @param {*} value - 日時候補
 * @returns {string|null} ISO日時、またはnull
 */
function toIsoDateTimeString(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * command authority view を安全側へ正規化する。
 *
 * 【詳細説明】
 * - 既定では必ずread-onlyにし、明示的な`commandAuthority.canSendCommands=true`がある場合だけ候補権限を返す。
 * - `commandAuthority`は呼び出し側申告のUI表示候補であり、security authorityや送信許可証跡ではない。
 * - ここで返す値はUI表示/disabled判定用であり、実送信時の最終権限はcommand dispatcher側で再検証する。
 *
 * @private
 * @param {object|null|undefined} commandAuthority - 呼び出し側が明示したcommand UI candidate hint
 * @returns {object} 表示用command authority
 */
function normalizeCommandAuthorityView(commandAuthority) {
  const source = commandAuthority && typeof commandAuthority === "object" ? commandAuthority : {};
  const allowedActions = new Set(Array.isArray(source.allowedActions) ? source.allowedActions : []);
  const canSendCommands = source.canSendCommands === true;
  return {
    mode: canSendCommands ? "command-candidate-view" : "read-only-view",
    canDriveLedger: false,
    canSendCommands,
    allowedActions: MATERIAL_CONTROL_ACTIONS.filter((action) => allowedActions.has(action)),
    reason: canSendCommands
      ? (source.reason || null)
      : (source.reason || "command-authority-not-enabled"),
    sourceAuthority: source.sourceAuthority || source.source || null,
  };
}

/**
 * 表示用 percent を整形する。
 *
 * 【詳細説明】
 * - rawPercent が壊れている場合でも normalizedPercent があればバー表示に使えるよう保持する。
 * - authority は必ず observation-only のまま返し、台帳残量と誤認しないようにする。
 *
 * @private
 * @param {object|null|undefined} source - material source
 * @returns {object} 表示用残量情報
 */
function createRemainingView(source) {
  if (!source) {
    return {
      rawPercent: null,
      normalizedPercent: null,
      displayPercent: null,
      valid: null,
      confidence: "unknown",
      authority: "observation-only",
      provenance: null,
    };
  }
  const remaining = source?.status?.remaining && typeof source.status.remaining === "object"
    ? source.status.remaining
    : {};
  const rawPercent = toFiniteNumber(remaining.rawPercent, toFiniteNumber(source?.status?.percent));
  const normalizedPercent = toFiniteNumber(
    remaining.normalizedPercent,
    toFiniteNumber(source?.status?.percent)
  );
  return {
    rawPercent,
    normalizedPercent,
    displayPercent: normalizedPercent,
    valid: remaining.valid === undefined ? (rawPercent === null ? null : true) : remaining.valid === true,
    confidence: remaining.confidence || "unknown",
    authority: remaining.authority || "observation-only",
    provenance: remaining.provenance || null,
  };
}

/**
 * material source の装填状態を表示ラベルへ変換する。
 *
 * 【詳細説明】
 * - firmware state code の厳密な意味は実機Gateで確定するため、ここでは空/観測/未観測/不明だけを保守的に表す。
 * - material名・色・RFIDは残留metadataとして残る場合があるため、物理的な装填証拠には使わない。
 *
 * @private
 * @param {object|null|undefined} source - material source
 * @returns {string} 表示用状態ラベル
 */
function derivePresenceState(source) {
  if (!source) {
    return "unobserved";
  }
  const explicitPresence = String(source.presence || "").trim();
  if (["loaded", "empty", "unknown", "unobserved"].includes(explicitPresence)) {
    return explicitPresence;
  }
  const stateCode = toFiniteNumber(source.status?.stateCode);
  if (stateCode === 1) {
    return "loaded";
  }
  if (stateCode === 0) {
    return "empty";
  }
  if (stateCode === null) {
    return "unknown";
  }
  return "unknown";
}

/**
 * sourceId に対応する assignment 一覧を返す。
 *
 * 【詳細説明】
 * - assignment は1sourceに複数紐づく可能性があるため配列で返す。
 *
 * @private
 * @param {Array<object>} assignments - normalized assignment 一覧
 * @param {?string} sourceId - source ID
 * @returns {Array<object>} source に紐づく assignment 一覧
 */
function findAssignmentsForSource(assignments, sourceId) {
  if (!sourceId) {
    return [];
  }
  return (Array.isArray(assignments) ? assignments : []).filter((assignment) => {
    return assignment?.sourceId === sourceId;
  });
}

/**
 * 任意値を空白除去済み文字列へ変換する。
 *
 * 【詳細説明】
 * - accounting read model は保存済みstoreやmigration由来の値を含むため、表示境界でも空文字を除外する。
 *
 * @private
 * @function toTrimmedText
 * @param {*} value - 文字列候補
 * @returns {string} 空白除去済み文字列。不正値は空文字。
 */
function toTrimmedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * accounting mapへkeyを追加し、衝突時は曖昧状態として保持する。
 *
 * 【詳細説明】
 * - 同じ観測source keyに複数のMaterialSourceが紐付く場合は、先勝ちで誤った残量を表示せず曖昧として扱う。
 *
 * @private
 * @function addAccountingLookupKey
 * @param {Map<string, object>} map - key別accounting source map
 * @param {*} key - 追加候補key
 * @param {object} source - accounting source
 * @returns {void}
 */
function addAccountingLookupKey(map, key, source) {
  const normalizedKey = toTrimmedText(key);
  const sourceId = toTrimmedText(source?.materialSourceId);
  if (!normalizedKey || !sourceId) {
    return;
  }
  const current = map.get(normalizedKey);
  if (!current) {
    map.set(normalizedKey, {
      status: "unique",
      source,
      sourceIds: new Set([sourceId]),
    });
    return;
  }
  if (current.sourceIds.has(sourceId)) {
    return;
  }
  current.status = "ambiguous";
  current.source = null;
  current.sourceIds.add(sourceId);
}

/**
 * locatorからsource照合用keyを生成する。
 *
 * 【詳細説明】
 * - Universal MaterialSource IDはstable ID、observed sourceIdはprotocol locator由来IDになり得る。
 * - そのため表示合流では、同じ物理slotを示すlocator keyをsourceIdとは別に生成する。
 *
 * @private
 * @function createLocatorLookupKeys
 * @param {object|null|undefined} locator - MaterialSource locator候補
 * @returns {string[]} 照合用locator key一覧
 */
function createLocatorLookupKeys(locator) {
  const source = locator && typeof locator === "object" ? locator : {};
  const kind = toTrimmedText(source.kind);
  const keys = [];
  if (!kind) {
    return keys;
  }
  const index = toFiniteNumber(source.index);
  const unitIndex = toFiniteNumber(source.unitIndex);
  const boxId = toFiniteNumber(source.boxId);
  const slotIndex = toFiniteNumber(source.slotIndex);
  const protocolSlotId = toTrimmedText(source.protocolSlotId);
  if (Number.isInteger(index)) {
    keys.push(`locator:${kind}:index:${index}`);
  }
  if (Number.isInteger(unitIndex) && Number.isInteger(slotIndex)) {
    keys.push(`locator:${kind}:unit:${unitIndex}:slot:${slotIndex}`);
  }
  if (Number.isInteger(boxId) && Number.isInteger(slotIndex)) {
    keys.push(`locator:${kind}:box:${boxId}:slot:${slotIndex}`);
  }
  if (protocolSlotId) {
    keys.push(`locator:${kind}:protocol:${protocolSlotId.toLowerCase()}`);
  }
  return keys;
}

/**
 * accounting sourceから照合keyを列挙する。
 *
 * 【詳細説明】
 * - canonical materialSourceId、snapshot内MaterialSource、mount、alias、locatorをすべて候補にする。
 * - UIは7桁色やlocator意味を解釈せず、ここでsource合流だけを担当する。
 *
 * @private
 * @function collectAccountingLookupKeys
 * @param {object|null|undefined} source - accounting source候補
 * @returns {string[]} 照合用key一覧
 */
function collectAccountingLookupKeys(source) {
  const observationMaterialSource = source?.observation?.materialSource &&
    typeof source.observation.materialSource === "object"
    ? source.observation.materialSource
    : {};
  const keys = [
    toTrimmedText(source?.materialSourceId),
    toTrimmedText(source?.mount?.materialSourceId),
    toTrimmedText(observationMaterialSource.materialSourceId),
  ];
  for (const alias of [
    ...(Array.isArray(source?.aliases) ? source.aliases : []),
    ...(Array.isArray(source?.observation?.aliases) ? source.observation.aliases : []),
    ...(Array.isArray(observationMaterialSource.aliases) ? observationMaterialSource.aliases : []),
  ]) {
    keys.push(toTrimmedText(alias));
  }
  keys.push(...createLocatorLookupKeys(source?.locator));
  keys.push(...createLocatorLookupKeys(source?.observation?.locator));
  keys.push(...createLocatorLookupKeys(observationMaterialSource.locator));
  return keys.filter(Boolean);
}

/**
 * 観測source rowからaccounting照合keyを列挙する。
 *
 * 【詳細説明】
 * - normalized topologyのsourceId、将来追加されるmaterialSourceId/alias、物理slot locatorを順に候補にする。
 * - CFS表示ではboxId/slotIdと表示slot名の両方をkey化し、`1C` と `cfs:1:slot:2` の橋渡しを行う。
 *
 * @private
 * @function collectObservedSourceLookupKeys
 * @param {object|null|undefined} source - normalized material source候補
 * @param {object} options - 表示行オプション
 * @returns {string[]} 照合用key一覧
 */
function collectObservedSourceLookupKeys(source, options) {
  if (!source) {
    return [];
  }
  const keys = [
    toTrimmedText(source.sourceId),
    toTrimmedText(source.materialSourceId),
    ...(Array.isArray(source.aliases) ? source.aliases.map((alias) => toTrimmedText(alias)) : []),
  ];
  const locator = {
    kind: source.kind || options.kind,
    index: source.kind === "external-spool" ? source.slotId : undefined,
    unitIndex: options.unitIndex !== null && options.unitIndex !== undefined ? options.unitIndex + 1 : undefined,
    boxId: source.boxId,
    slotIndex: source.slotId ?? options.slotIndex,
    protocolSlotId: source.protocolSlotId || source.slotIdLabel || options.displaySlot,
  };
  keys.push(...createLocatorLookupKeys(locator));
  return keys.filter(Boolean);
}

/**
 * source-aware accounting view を sourceId map へ変換する。
 *
 * 【詳細説明】
 * - accounting view は3DPmon内のスプール管理・使用量候補であり、機器観測topologyとは別authorityである。
 * - ViewModelではsourceId、alias、locator一致だけで表示へ合流し、残量やdebitの権威化は行わない。
 *
 * @private
 * @function createAccountingSourceMap
 * @param {object|null|undefined} accountingView - MaterialSourceAccountingView候補
 * @returns {Map<string, object>} 照合keyからaccounting rowへのMap
 */
function createAccountingSourceMap(accountingView) {
  const map = new Map();
  for (const source of Array.isArray(accountingView?.sources) ? accountingView.sources : []) {
    for (const key of collectAccountingLookupKeys(source)) {
      addAccountingLookupKey(map, key, source);
    }
  }
  return map;
}

/**
 * source rowに対応するaccounting sourceを取得する。
 *
 * 【詳細説明】
 * - raw sourceId一致を第一候補にしつつ、Universal MaterialSource ID導入後のalias/locator一致へfallbackする。
 *
 * @private
 * @function resolveAccountingSourceForRow
 * @param {object|null|undefined} source - normalized material source候補
 * @param {object} options - 表示行オプション
 * @returns {{accounting:object|null,diagnostics:object[]}} accounting解決結果。
 */
function resolveAccountingSourceForRow(source, options) {
  const accountingBySourceId = options.accountingBySourceId;
  if (!accountingBySourceId || !source) {
    return { accounting: null, diagnostics: [] };
  }
  for (const key of collectObservedSourceLookupKeys(source, options)) {
    const entry = accountingBySourceId.get(key);
    if (!entry) {
      continue;
    }
    if (entry.status === "ambiguous") {
      return {
        accounting: null,
        diagnostics: [
          {
            code: "ambiguous-accounting-source",
            severity: "warning",
            key,
            materialSourceIds: [...entry.sourceIds],
          },
        ],
      };
    }
    return { accounting: entry.source || null, diagnostics: [] };
  }
  return { accounting: null, diagnostics: [] };
}

/**
 * material source を表示行へ変換する。
 *
 * 【詳細説明】
 * - slot row は固定枠にもsourceあり枠にも使うため、source欠落時は `presence:"unobserved"` として返す。
 *
 * @private
 * @param {object} options - 変換オプション
 * @param {object|null} options.source - material source
 * @param {Array<object>} options.assignments - normalized assignment 一覧
 * @param {string} options.kind - 表示行種別
 * @param {string} options.displaySlot - 表示スロット名
 * @param {?number} options.unitIndex - 表示ユニットindex
 * @param {?number} options.slotIndex - 表示スロットindex
 * @param {Map<string, object>=} options.accountingBySourceId - sourceId別accounting view。
 * @returns {object} 表示行
 */
function createSourceRow(options) {
  const source = options.source || null;
  const sourceAssignments = findAssignmentsForSource(options.assignments, source?.sourceId);
  const material = source?.material && typeof source.material === "object" ? source.material : {};
  const remaining = createRemainingView(source);
  const accountingResolution = resolveAccountingSourceForRow(source, options);
  return {
    rowId: source?.sourceId || `${options.kind}:${options.displaySlot}`,
    sourceId: source?.sourceId || null,
    kind: options.kind,
    displaySlot: options.displaySlot,
    unitIndex: options.unitIndex,
    slotIndex: options.slotIndex,
    boxId: source?.boxId ?? null,
    protocolSlotId: source?.slotId ?? null,
    presence: derivePresenceState(source),
    selected: toNullableBoolean(source?.status?.selected),
    material: {
      vendor: material.vendor ?? null,
      type: material.type ?? null,
      name: material.name ?? null,
      color: material.color || { raw: "", normalized: "" },
      rfid: material.rfid ?? null,
      minTemp: material.minTemp ?? null,
      maxTemp: material.maxTemp ?? null,
      pressure: material.pressure ?? null,
    },
    status: {
      stateCode: toFiniteNumber(source?.status?.stateCode),
      editStatusCode: toFiniteNumber(source?.status?.editStatusCode),
      scrap: toFiniteNumber(source?.status?.scrap),
      selectionState: source?.status?.selectionState || "unobserved",
      selectionValid: source?.status?.selectionValid ?? null,
      selectionRaw: source?.status?.selectionRaw,
      remaining,
    },
    assignments: sourceAssignments.map((assignment) => ({
      assignmentId: assignment.assignmentId ?? null,
      namespace: assignment.namespace ?? null,
      resolution: assignment.resolution ?? "unknown",
    })),
    accounting: accountingResolution.accounting,
    diagnostics: accountingResolution.diagnostics,
  };
}

/**
 * CFS unit を boxId 昇順で取得する。
 *
 * 【詳細説明】
 * - normalized topology の units が欠落していても、source 側の unitId から最小限の表示unitを補完する。
 *
 * @private
 * @param {object|null|undefined} topology - normalized material topology
 * @returns {Array<object>} 表示対象 unit 一覧
 */
function collectUnits(topology) {
  const units = Array.isArray(topology?.units) ? topology.units : [];
  const unitMap = new Map();
  for (const unit of units) {
    if (!unit?.unitId) {
      continue;
    }
    unitMap.set(unit.unitId, unit);
  }
  for (const source of Array.isArray(topology?.sources) ? topology.sources : []) {
    if (source?.kind !== "cfs-slot" || !source?.unitId || unitMap.has(source.unitId)) {
      continue;
    }
    unitMap.set(source.unitId, {
      unitId: source.unitId,
      boxId: source.boxId,
      stateCode: source.boxStateCode ?? null,
      observedSlotCount: 0,
    });
  }
  return [...unitMap.values()].sort((a, b) => {
    return (toFiniteNumber(a.boxId, 9999) ?? 9999) - (toFiniteNumber(b.boxId, 9999) ?? 9999);
  });
}

/**
 * 観測済みunitを表示unit 1-4 の固定位置へ配置する。
 *
 * 【詳細説明】
 * - 物理boxIdが1-4で報告される場合は、配列を詰めず `boxId - 1` へ配置する。
 * - boxId未報告のproviderでは、未使用枠へ順番に配置して後方互換を維持する。
 * - boxIdが表示範囲外の場合は誤った番号へcompactせず、現在設定では表示対象外として扱う。
 *
 * @private
 * @param {Array<object>} units - 観測済みunit一覧
 * @param {number} unitLimit - 表示unit数
 * @returns {Array<object|null>} 表示位置ごとのunit一覧
 */
function placeUnitsByDisplayIndex(units, unitLimit) {
  const placedUnits = Array.from({ length: unitLimit }, () => null);
  const fallbackUnits = [];
  for (const unit of Array.isArray(units) ? units : []) {
    const boxId = toFiniteNumber(unit?.boxId);
    if (Number.isInteger(boxId) && boxId >= 1) {
      const index = boxId - 1;
      if (index < unitLimit && !placedUnits[index]) {
        placedUnits[index] = unit;
      }
      continue;
    }
    fallbackUnits.push(unit);
  }
  for (const unit of fallbackUnits) {
    const index = placedUnits.findIndex((placed) => !placed);
    if (index < 0) {
      break;
    }
    placedUnits[index] = unit;
  }
  return placedUnits;
}

/**
 * CFS slot source を unitId と slotId で引ける Map にする。
 *
 * 【詳細説明】
 * - sourceIdを直接組み立てず、normalized sourceの実値を参照する。
 *
 * @private
 * @param {Array<object>} sources - normalized source 一覧
 * @returns {Map<string, object>} `unitId:slotIndex` から source への Map
 */
function createCfsSourceMap(sources) {
  const sourceMap = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.kind !== "cfs-slot") {
      continue;
    }
    const slotId = toFiniteNumber(source.slotId);
    if (!source.unitId || slotId === null) {
      continue;
    }
    const key = `${source.unitId}:${slotId}`;
    if (!sourceMap.has(key)) {
      sourceMap.set(key, source);
    }
  }
  return sourceMap;
}

/**
 * 外部スプール表示行を生成する。
 *
 * 【詳細説明】
 * - 外部sourceが未観測でも固定行を返し、UIが「外部スプールなし/未観測」を表示できるようにする。
 *
 * @private
 * @param {object} topology - normalized material topology
 * @param {number} limit - 外部スプール表示数
 * @returns {Array<object>} 外部スプール表示行
 */
function createExternalRows(topology, limit, accountingBySourceId) {
  const assignments = Array.isArray(topology.assignments) ? topology.assignments : [];
  const externalSources = (Array.isArray(topology.sources) ? topology.sources : [])
    .filter((source) => source?.kind === "external-spool")
    .sort((a, b) => (toFiniteNumber(a.slotId, 9999) ?? 9999) - (toFiniteNumber(b.slotId, 9999) ?? 9999))
    .slice(0, limit);
  const rows = [];
  const rowCount = Math.max(limit, externalSources.length);
  for (let index = 0; index < rowCount; index += 1) {
    rows.push(createSourceRow({
      source: externalSources[index] || null,
      assignments,
      kind: "external-spool",
      displaySlot: index === 0 ? "external" : `external-${index + 1}`,
      unitIndex: null,
      slotIndex: index,
      accountingBySourceId,
    }));
  }
  return rows;
}

/**
 * CFS unit 表示行を生成する。
 *
 * 【詳細説明】
 * - 最大4unit x 4slot の固定枠を作る。未観測unitは `presence:"unobserved"` の空slotだけを持つ。
 *
 * @private
 * @param {object} topology - normalized material topology
 * @param {object} options - 表示オプション
 * @param {number} options.unitLimit - 最大unit数
 * @param {number} options.slotsPerUnit - 1unitあたりslot数
 * @returns {Array<object>} CFS unit 表示行
 */
function createCfsUnitRows(topology, options, accountingBySourceId) {
  const assignments = Array.isArray(topology.assignments) ? topology.assignments : [];
  const sourceMap = createCfsSourceMap(topology.sources);
  const units = placeUnitsByDisplayIndex(collectUnits(topology), options.unitLimit);
  const rows = [];
  for (let unitIndex = 0; unitIndex < options.unitLimit; unitIndex += 1) {
    const unit = units[unitIndex] || null;
    const displayUnitNumber = unitIndex + 1;
    const slots = [];
    for (let slotIndex = 0; slotIndex < options.slotsPerUnit; slotIndex += 1) {
      const source = unit?.unitId ? sourceMap.get(`${unit.unitId}:${slotIndex}`) || null : null;
      const suffix = SLOT_SUFFIXES[slotIndex] || String(slotIndex + 1);
      slots.push(createSourceRow({
        source,
        assignments,
        kind: "cfs-slot",
        displaySlot: `${displayUnitNumber}${suffix}`,
        unitIndex,
        slotIndex,
        accountingBySourceId,
      }));
    }
    rows.push({
      unitId: unit?.unitId || null,
      displayUnit: displayUnitNumber,
      boxId: unit?.boxId ?? null,
      stateCode: toFiniteNumber(unit?.stateCode),
      temperature: toFiniteNumber(unit?.temperature),
      humidity: toFiniteNumber(unit?.humidity),
      serialNumber: unit?.serialNumber ?? null,
      observedSlotCount: toFiniteNumber(unit?.observedSlotCount, 0),
      observed: Boolean(unit),
      slots,
    });
  }
  return rows;
}

/**
 * 表示用 summary を生成する。
 *
 * 【詳細説明】
 * - 操作や物理変化の監視に必要な loaded/selected/invalid/stale の件数をまとめる。
 *
 * @private
 * @param {Array<object>} externalRows - 外部スプール表示行
 * @param {Array<object>} cfsUnits - CFS unit 表示行
 * @param {object} topology - normalized material topology
 * @returns {object} 表示用 summary
 */
function createSummary(externalRows, cfsUnits, topology) {
  const cfsRows = cfsUnits.flatMap((unit) => unit.slots);
  const allRows = [...externalRows, ...cfsRows];
  return {
    externalSourceCount: externalRows.filter((row) => row.sourceId).length,
    cfsUnitCount: cfsUnits.filter((unit) => unit.observed).length,
    cfsSlotCapacity: cfsRows.length,
    cfsObservedSlotCount: cfsRows.filter((row) => row.sourceId).length,
    loadedSourceCount: allRows.filter((row) => row.presence === "loaded").length,
    selectedSourceCount: allRows.filter((row) => row.selected === true).length,
    invalidSelectionCount: allRows.filter((row) => row.status.selectionValid === false).length,
    invalidRemainingCount: allRows.filter((row) => row.status.remaining.valid === false).length,
    assignmentCount: allRows.reduce((count, row) => count + row.assignments.length, 0),
    topologyState: topology?.cfs?.topologyState || "unobserved",
    connected: topology?.cfs?.connected ?? null,
    enabled: topology?.cfs?.enabled ?? null,
  };
}

/**
 * material topology の観測・通信状態を表示用に正規化する。
 *
 * 【詳細説明】
 * - provider.lastObservedAt は「現在値/最終観測値がいつのものか」を利用者へ示すため必ずViewModelへ渡す。
 * - materialProviderRequest は通信中表示専用であり、slot情報や台帳authorityとは分離する。
 *
 * @private
 * @param {object} topology - normalized material topology
 * @param {object|null|undefined} observation - runtimeData由来の観測補助情報
 * @returns {object} 表示用観測情報
 */
function createObservationView(topology, observation) {
  const request = observation?.request && typeof observation.request === "object"
    ? observation.request
    : {};
  const requestStartedAtMs = toFiniteNumber(request.startedAtMs);
  const nowMs = toFiniteNumber(observation?.nowMs, Date.now());
  const requestElapsedSeconds = request.state === "in-flight" && requestStartedAtMs !== null
    ? Math.max(0, Math.floor(((nowMs ?? Date.now()) - requestStartedAtMs) / 1000))
    : null;
  return {
    lastObservedAt: toIsoDateTimeString(
      topology?.provider?.lastObservedAt ??
      observation?.lastObservedAt
    ),
    request: {
      state: request.state || "idle",
      startedAt: toIsoDateTimeString(request.startedAt),
      startedAtMs: requestStartedAtMs,
      elapsedSeconds: requestElapsedSeconds,
      updatedAt: toIsoDateTimeString(request.updatedAt),
    },
  };
}

/**
 * material topology から表示用 view model を生成する。
 *
 * 【詳細説明】
 * - 入力は Printer Core v3 の NormalizedState `materials` または MaterialProvider topology を想定する。
 * - 既定の返り値はread-only表示専用で、spool mount、ledger、load/unload/select command の authority にはしない。
 * - `options.commandAuthority` が明示された場合だけ、UIの操作候補表示に使うauthority情報を同梱する。
 *   ただし実送信可否は送信直前dispatcherで再検証する。
 * - CFS/CFS-C は最大4unit x 4slot、外部スプールは既定1本の固定枠として表示できる。
 *
 * @function createMaterialTopologyViewModel
 * @param {object|null|undefined} topology - normalized material topology
 * @param {object=} options - 表示オプション
 * @param {number=} options.unitLimit - 最大CFS unit数
 * @param {number=} options.slotsPerUnit - CFS 1unitあたりslot数
 * @param {number=} options.externalSourceLimit - 外部スプール表示数
 * @param {object=} options.commandAuthority - UI操作候補用command authority
 * @param {object=} options.observation - runtimeData由来の観測・通信補助情報
 * @param {object=} options.accountingView - source-aware accounting read model
 * @returns {object} material topology 表示用 view model
 * @example
 * const viewModel = createMaterialTopologyViewModel(state.materials);
 */
export function createMaterialTopologyViewModel(topology, options = {}) {
  const safeTopology = topology && typeof topology === "object" ? topology : {};
  const unitLimit = Math.max(0, Math.min(4, Math.floor(toFiniteNumber(options.unitLimit, DEFAULT_CFS_UNIT_LIMIT) ?? DEFAULT_CFS_UNIT_LIMIT)));
  const slotsPerUnit = Math.max(0, Math.min(4, Math.floor(toFiniteNumber(options.slotsPerUnit, DEFAULT_CFS_SLOTS_PER_UNIT) ?? DEFAULT_CFS_SLOTS_PER_UNIT)));
  const externalSourceLimit = Math.max(0, Math.min(1, Math.floor(toFiniteNumber(options.externalSourceLimit, DEFAULT_EXTERNAL_SOURCE_LIMIT) ?? DEFAULT_EXTERNAL_SOURCE_LIMIT)));
  const accountingBySourceId = createAccountingSourceMap(options.accountingView);
  const externalRows = createExternalRows(safeTopology, externalSourceLimit, accountingBySourceId);
  const cfsUnits = createCfsUnitRows(safeTopology, { unitLimit, slotsPerUnit }, accountingBySourceId);
  const commandAuthority = normalizeCommandAuthorityView(options.commandAuthority);
  return {
    schemaVersion: MATERIAL_TOPOLOGY_VIEW_MODEL_SCHEMA_VERSION,
    authority: {
      ...commandAuthority,
      sourceAuthority: commandAuthority.sourceAuthority || safeTopology.authority?.mode || "unknown",
    },
    limits: {
      externalSourceLimit,
      cfsUnitLimit: unitLimit,
      slotsPerUnit,
      maxDisplayedSources: externalSourceLimit + (unitLimit * slotsPerUnit),
    },
    cfs: {
      connected: safeTopology.cfs?.connected ?? null,
      enabled: safeTopology.cfs?.enabled ?? null,
      topologyState: safeTopology.cfs?.topologyState || "unobserved",
      provider: safeTopology.provider || null,
    },
    observation: createObservationView(safeTopology, options.observation),
    external: externalRows,
    units: cfsUnits,
    diagnostics: Array.isArray(safeTopology.diagnostics) ? [...safeTopology.diagnostics] : [],
    summary: createSummary(externalRows, cfsUnits, safeTopology),
  };
}
