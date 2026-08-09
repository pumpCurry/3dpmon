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
 *
 * 【公開関数一覧】
 * - {@link createMaterialTopologyViewModel}：material topology から表示用 view model を生成
 *
 * @version 1.390.1362 (PR #432)
 * @since   1.390.1361 (PR #432)
 * @lastModified 2026-08-09 16:48:00
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
 *
 * @private
 * @param {object|null|undefined} source - material source
 * @returns {string} 表示用状態ラベル
 */
function derivePresenceState(source) {
  if (!source) {
    return "unobserved";
  }
  const stateCode = toFiniteNumber(source.status?.stateCode);
  const material = source.material && typeof source.material === "object" ? source.material : {};
  const hasMaterialText = Boolean(
    String(material.type || "").trim() ||
    String(material.name || "").trim() ||
    String(material.color?.normalized || material.color?.raw || "").trim() ||
    String(material.rfid || "").trim()
  );
  if (stateCode === 0 && !hasMaterialText) {
    return "empty";
  }
  if (stateCode === null && !hasMaterialText) {
    return "unknown";
  }
  return "loaded";
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
 * @returns {object} 表示行
 */
function createSourceRow(options) {
  const source = options.source || null;
  const sourceAssignments = findAssignmentsForSource(options.assignments, source?.sourceId);
  const material = source?.material && typeof source.material === "object" ? source.material : {};
  const remaining = createRemainingView(source);
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
      remaining,
    },
    assignments: sourceAssignments.map((assignment) => ({
      assignmentId: assignment.assignmentId ?? null,
      namespace: assignment.namespace ?? null,
      resolution: assignment.resolution ?? "unknown",
    })),
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
function createExternalRows(topology, limit) {
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
function createCfsUnitRows(topology, options) {
  const assignments = Array.isArray(topology.assignments) ? topology.assignments : [];
  const sourceMap = createCfsSourceMap(topology.sources);
  const units = collectUnits(topology).slice(0, options.unitLimit);
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
    invalidRemainingCount: allRows.filter((row) => row.status.remaining.valid === false).length,
    assignmentCount: allRows.reduce((count, row) => count + row.assignments.length, 0),
    topologyState: topology?.cfs?.topologyState || "unobserved",
    connected: topology?.cfs?.connected ?? null,
    enabled: topology?.cfs?.enabled ?? null,
  };
}

/**
 * material topology から表示用 view model を生成する。
 *
 * 【詳細説明】
 * - 入力は Printer Core v3 の NormalizedState `materials` または MaterialProvider topology を想定する。
 * - 返り値はread-only表示専用で、spool mount、ledger、load/unload/select command の authority にはしない。
 * - CFS/CFS-C は最大4unit x 4slot、外部スプールは既定1本の固定枠として表示できる。
 *
 * @function createMaterialTopologyViewModel
 * @param {object|null|undefined} topology - normalized material topology
 * @param {object=} options - 表示オプション
 * @param {number=} options.unitLimit - 最大CFS unit数
 * @param {number=} options.slotsPerUnit - CFS 1unitあたりslot数
 * @param {number=} options.externalSourceLimit - 外部スプール表示数
 * @returns {object} material topology 表示用 view model
 * @example
 * const viewModel = createMaterialTopologyViewModel(state.materials);
 */
export function createMaterialTopologyViewModel(topology, options = {}) {
  const safeTopology = topology && typeof topology === "object" ? topology : {};
  const unitLimit = Math.max(0, Math.min(4, Math.floor(toFiniteNumber(options.unitLimit, DEFAULT_CFS_UNIT_LIMIT) ?? DEFAULT_CFS_UNIT_LIMIT)));
  const slotsPerUnit = Math.max(0, Math.min(4, Math.floor(toFiniteNumber(options.slotsPerUnit, DEFAULT_CFS_SLOTS_PER_UNIT) ?? DEFAULT_CFS_SLOTS_PER_UNIT)));
  const externalSourceLimit = Math.max(0, Math.min(1, Math.floor(toFiniteNumber(options.externalSourceLimit, DEFAULT_EXTERNAL_SOURCE_LIMIT) ?? DEFAULT_EXTERNAL_SOURCE_LIMIT)));
  const externalRows = createExternalRows(safeTopology, externalSourceLimit);
  const cfsUnits = createCfsUnitRows(safeTopology, { unitLimit, slotsPerUnit });
  return {
    schemaVersion: MATERIAL_TOPOLOGY_VIEW_MODEL_SCHEMA_VERSION,
    authority: {
      mode: "read-only-view",
      canDriveLedger: false,
      canSendCommands: false,
      sourceAuthority: safeTopology.authority?.mode || "unknown",
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
    external: externalRows,
    units: cfsUnits,
    diagnostics: Array.isArray(safeTopology.diagnostics) ? [...safeTopology.diagnostics] : [],
    summary: createSummary(externalRows, cfsUnits, safeTopology),
  };
}
