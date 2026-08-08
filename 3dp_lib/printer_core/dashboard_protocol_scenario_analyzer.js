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
 * - {@link getProtocolScenarioProfile}：標準 scenario profile を取得
 * - {@link listProtocolScenarioProfiles}：利用可能な標準 scenario profile 名を列挙
 *
 * @version 1.390.1321 (PR #432)
 * @since   1.390.1314 (PR #432)
 * @lastModified 2026-08-08 09:23:03
 * -----------------------------------------------------------
 * @todo
 * - K2 print lifecycle 実機 fixture 取得後に state/window predicate を追加する
 */

"use strict";

/**
 * 標準 scenario profile 定義。
 *
 * 【詳細説明】
 * - profile は CLI の長い required marker / payload key 指定をまとめるための読み取り専用定義。
 * - `k2-print-lifecycle` は Gate 9 の連続実機 capture 用であり、state semantics の認定ではなく
 *   raw evidence が揃っているかだけを確認する。
 *
 * @constant {object}
 */
const PROTOCOL_SCENARIO_PROFILE_DEFINITIONS = Object.freeze({
  "k2-print-lifecycle": Object.freeze({
    name: "k2-print-lifecycle",
    expectedScenario: "k2-print-lifecycle",
    requireValidationSuccess: true,
    requiredMarkers: Object.freeze([
      Object.freeze({ name: "observed-idle-before-start", source: "stdin" }),
      Object.freeze({ name: "operator-print-start", source: "stdin" }),
      Object.freeze({ name: "observed-heating", source: "stdin" }),
      Object.freeze({ name: "observed-printing", source: "stdin" }),
      Object.freeze({ name: "operator-pause-requested", source: "stdin" }),
      Object.freeze({ name: "observed-paused", source: "stdin" }),
      Object.freeze({ name: "operator-resume-requested", source: "stdin" }),
      Object.freeze({ name: "observed-resumed", source: "stdin" }),
      Object.freeze({ name: "observed-completed", source: "stdin" }),
      Object.freeze({ name: "observed-idle-after-completed", source: "stdin" }),
    ]),
    requiredPayloadKeys: Object.freeze([
      "state",
      "deviceState",
      "printProgress",
      "printFileName",
      "printId",
      "nozzleTemp",
      "targetNozzleTemp",
      "bedTemp0",
      "targetBedTemp0",
      "cfsConnect",
      "boxsInfo",
    ]),
    timelinePayloadKeys: Object.freeze([
      "state",
      "deviceState",
      "printProgress",
      "printFileName",
      "printId",
    ]),
  }),
  "k2-cfs-topology": Object.freeze({
    name: "k2-cfs-topology",
    expectedScenario: "k2-cfs-topology-validation",
    requireValidationSuccess: true,
    requiredMarkers: Object.freeze([
      Object.freeze({ name: "observed-cfs-connected", source: "stdin" }),
      Object.freeze({ name: "operator-cfs-disconnect", source: null }),
      Object.freeze({ name: "observed-cfs-disconnected", source: "stdin" }),
      Object.freeze({ name: "operator-cfs-reconnect", source: null }),
      Object.freeze({ name: "observed-cfs-reconnected", source: "stdin" }),
      Object.freeze({ name: "observed-slot-change", source: "stdin" }),
      Object.freeze({ name: "observed-material-change", source: "stdin" }),
      Object.freeze({ name: "observed-external-spool", source: "stdin" }),
      Object.freeze({ name: "observed-color-assignment-change", source: "stdin" }),
    ]),
    requiredPayloadKeys: Object.freeze([
      "cfsConnect",
      "boxsInfo",
    ]),
    timelinePayloadKeys: Object.freeze([
      "cfsConnect",
      "boxsInfo",
    ]),
  }),
});

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
 * 文字列配列から重複を除去する。
 *
 * 【詳細説明】
 * - profile と CLI 個別指定を合成したときに同じ payload key を二重要求しないようにする。
 *
 * @private
 * @param {string[]} values - 文字列配列
 * @returns {string[]} 最初の出現順を保持した一意な文字列配列
 */
function uniqueStringList(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

/**
 * marker requirement 配列から重複を除去する。
 *
 * 【詳細説明】
 * - source 付き requirement は `source:name`、source 不問 requirement は `name` を重複判定キーにする。
 * - profile と CLI 個別指定の単純な重複を避け、同じ marker requirement で順序判定が不安定にならないようにする。
 *
 * @private
 * @param {Array<object>} requirements - 正規化済み marker requirement 一覧
 * @returns {Array<object>} 最初の出現順を保持した一意な requirement 一覧
 */
function uniqueMarkerRequirements(requirements) {
  const seen = new Set();
  return requirements.filter((requirement) => {
    const key = formatMarkerRequirement(requirement);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * 標準 scenario profile を安全に複製する。
 *
 * 【詳細説明】
 * - 呼び出し側が profile 定義を変更しても module 内の標準定義へ影響しないよう、配列と marker object を複製する。
 *
 * @private
 * @param {object} profile - 標準 profile 定義
 * @returns {object} 複製済み profile
 */
function cloneProtocolScenarioProfile(profile) {
  return {
    name: profile.name,
    expectedScenario: profile.expectedScenario,
    requireValidationSuccess: Boolean(profile.requireValidationSuccess),
    requiredMarkers: profile.requiredMarkers.map((marker) => ({
      name: marker.name,
      source: marker.source,
    })),
    requiredPayloadKeys: [...profile.requiredPayloadKeys],
    timelinePayloadKeys: [...(profile.timelinePayloadKeys || [])],
  };
}

/**
 * 利用可能な標準 scenario profile 名を列挙する。
 *
 * 【詳細説明】
 * - CLI の `--help` や unit test から、profile 名を定義と同期したまま参照するために使う。
 *
 * @function listProtocolScenarioProfiles
 * @returns {string[]} profile 名一覧
 * @example
 * const names = listProtocolScenarioProfiles();
 */
export function listProtocolScenarioProfiles() {
  return Object.keys(PROTOCOL_SCENARIO_PROFILE_DEFINITIONS);
}

/**
 * 標準 scenario profile を取得する。
 *
 * 【詳細説明】
 * - 未知 profile は null を返し、Analyzer report 側で failure reason に変換できるようにする。
 *
 * @function getProtocolScenarioProfile
 * @param {string} name - profile 名
 * @returns {object|null} 複製済み profile、または null
 * @example
 * const profile = getProtocolScenarioProfile("k2-print-lifecycle");
 */
export function getProtocolScenarioProfile(name) {
  const normalizedName = String(name || "").trim();
  const profile = PROTOCOL_SCENARIO_PROFILE_DEFINITIONS[normalizedName];
  return profile ? cloneProtocolScenarioProfile(profile) : null;
}

/**
 * fixture event から JSON payload body を取り出す。
 *
 * 【詳細説明】
 * - WS9999 の `payload.body` と、テスト用の直接 `payload` の両方を許容する。
 * - body が `{ result:{...} }` や `{ data:{...} }` wrapper の場合も payload key 検査で扱えるよう、
 *   呼び出し側で既知 envelope を1段だけ展開する。
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
 * Protocol payload の既知 envelope を展開する。
 *
 * 【詳細説明】
 * - Creality firmware と capture helper は root payload、`result` wrapper、`data` wrapper の
 *   いずれかで semantic payload を持つことがある。
 * - `boxsInfo.materialBoxs[].state` のような入れ子 key を printer root の `state` と誤認しないよう、
 *   任意深度の再帰探索は行わず、既知 wrapper を1段だけ外す。
 *
 * @private
 * @param {object|null} body - extractEventPayloadBody で取り出した payload body
 * @returns {object|null} semantic payload root、または null
 */
function unwrapProtocolEnvelope(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  if (body.result && typeof body.result === "object" && !Array.isArray(body.result)) {
    return body.result;
  }
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    return body.data;
  }
  return body;
}

/**
 * protocol event が指定 payload key を含むか判定する。
 *
 * 【詳細説明】
 * - marker、transport event、outbound request は payload key 検査の対象外にする。
 * - `boxsInfo` probe を送っただけで scenario evidence と誤判定しないよう、受信 frame だけを扱う。
 * - JSON body は root / result / data の既知 envelope だけを検査し、CFS内部の `state` などを
 *   printer status root の `state` と誤判定しないようにする。
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
  const body = unwrapProtocolEnvelope(extractEventPayloadBody(event));
  return hasOwn(body, normalizedKey);
}

/**
 * marker requirement を正規化する。
 *
 * 【詳細説明】
 * - Gate 8 以前の `requiredMarkers: ["name"]` は source 不問として互換維持する。
 * - 物理観測を scenario 合格条件にする場合は `{ name, source:"stdin" }` を使い、
 *   scheduled marker だけで observed marker を満たさないようにする。
 *
 * @private
 * @param {Array<string|object>|null|undefined} values - marker requirement 候補
 * @returns {Array<object>} 正規化済み requirement 一覧
 */
function normalizeMarkerRequirements(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      if (value && typeof value === "object") {
        const name = String(value.name ?? "").trim();
        const source = value.source == null ? null : String(value.source).trim();
        return {
          name,
          source: source || null,
        };
      }
      return {
        name: String(value ?? "").trim(),
        source: null,
      };
    })
    .filter((value) => value.name);
}

/**
 * source 付き marker requirement の表示名を作る。
 *
 * 【詳細説明】
 * - failure report では従来互換のため source 不問 requirement は name だけを返す。
 * - source 指定がある場合は `source:name` として、どの provenance が不足したかを明示する。
 *
 * @private
 * @param {object} requirement - marker requirement
 * @returns {string} report 用 label
 */
function formatMarkerRequirement(requirement) {
  return requirement.source ? `${requirement.source}:${requirement.name}` : requirement.name;
}

/**
 * marker が requirement を満たすか判定する。
 *
 * 【詳細説明】
 * - name は必須一致とし、source が指定された requirement では details.source 由来の
 *   marker summary source も一致させる。
 *
 * @private
 * @param {object} marker - marker summary
 * @param {object} requirement - marker requirement
 * @returns {boolean} requirement を満たす場合 true
 */
function markerMatchesRequirement(marker, requirement) {
  if (!marker || marker.name !== requirement.name) {
    return false;
  }
  return !requirement.source || marker.source === requirement.source;
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
 * - source 不問 marker と source 指定 marker の両方を扱う。
 * - 順序検査は requiredMarkers の順で最初に見つかった marker index が単調増加することを確認する。
 *
 * @private
 * @param {Array<object>} markers - marker summary 一覧
 * @param {Array<object>} requiredMarkers - 必須 marker requirement 一覧
 * @returns {object} marker 判定結果
 */
function analyzeRequiredMarkers(markers, requiredMarkers) {
  const matched = requiredMarkers.map((requirement) => {
    const index = markers.findIndex((marker) => markerMatchesRequirement(marker, requirement));
    return {
      name: requirement.name,
      source: requirement.source,
      label: formatMarkerRequirement(requirement),
      observed: index >= 0,
      index,
      atMs: index >= 0 ? markers[index].atMs : null,
      observedSource: index >= 0 ? markers[index].source : null,
    };
  });
  const missing = matched
    .filter((entry) => !entry.observed)
    .map((entry) => entry.label);
  const observedIndexes = matched
    .filter((entry) => entry.observed)
    .map((entry) => entry.index);
  const ordered = observedIndexes.every((index, position) => {
    return position === 0 || index > observedIndexes[position - 1];
  });
  return {
    required: requiredMarkers.map((requirement) => ({
      name: requirement.name,
      source: requirement.source,
      label: formatMarkerRequirement(requirement),
    })),
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
 * metadata.validation の event count と実 events を照合する。
 *
 * 【詳細説明】
 * - capture CLI は `metadata.json` と `events.ndjson` を同じ fixture から生成するため、本来 count は一致する。
 * - 手作業編集や不完全な fixture copy で片方だけが変わった場合、Analyzer report に差分を出す。
 * - 古い fixture で count が未記録の場合は互換維持のため検査対象外にする。
 *
 * @private
 * @param {object} metadata - fixture metadata
 * @param {number} eventCount - 実 events 件数
 * @param {number} protocolEventCount - 実 protocol event 件数
 * @param {number} markerCount - 実 marker event 件数
 * @returns {object} count 整合性 report
 */
function analyzeValidationCounts(metadata, eventCount, protocolEventCount, markerCount) {
  const validation = metadata?.validation && typeof metadata.validation === "object"
    ? metadata.validation
    : {};
  const checks = [
    { key: "eventCount", actual: eventCount },
    { key: "protocolEventCount", actual: protocolEventCount },
    { key: "markerCount", actual: markerCount },
  ].filter((entry) => Number.isFinite(validation[entry.key]));
  const mismatches = checks
    .filter((entry) => validation[entry.key] !== entry.actual)
    .map((entry) => ({
      key: entry.key,
      expected: validation[entry.key],
      actual: entry.actual,
    }));

  return {
    checked: checks.map((entry) => ({
      key: entry.key,
      expected: validation[entry.key],
      actual: entry.actual,
      matches: validation[entry.key] === entry.actual,
    })),
    mismatches,
    success: mismatches.length === 0,
  };
}

/**
 * CFS `same_material` の参照配列を timeline summary 用へ正規化する。
 *
 * 【詳細説明】
 * - 実機 F012 payload では material code は `materials[].materialId` ではなく
 *   `same_material[]` 側に現れるため、slot 情報と code/group 情報を分けて保持する。
 * - firmware 差分に備えて object 形式の参照も受け入れ、比較しやすい `{boxId, materialId}` へ揃える。
 *
 * @private
 * @param {Array<*>|null|undefined} refs - `same_material` group の参照一覧
 * @returns {Array<object>} 正規化済み参照一覧
 */
function summarizeSameMaterialRefs(refs) {
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.map((ref) => ({
    boxId: ref?.boxId ?? ref?.box_id ?? null,
    materialId: ref?.materialId ?? ref?.material_id ?? ref?.id ?? null,
  }));
}

/**
 * CFS `same_material` を timeline summary 用へ正規化する。
 *
 * 【詳細説明】
 * - Creality payload の material code / color / material type と、box slot 参照を同じ group にまとめる。
 * - array 形式と object 形式の両方を読むことで、実機 firmware 差分で analyzer が壊れにくくする。
 *
 * @private
 * @param {Array<*>|null|undefined} sameMaterial - raw `same_material` payload
 * @returns {Array<object>} 正規化済み same material group 一覧
 */
function summarizeSameMaterialGroups(sameMaterial) {
  if (!Array.isArray(sameMaterial)) {
    return [];
  }
  return sameMaterial.map((group) => {
    if (Array.isArray(group)) {
      return {
        materialCode: group[0] ?? null,
        color: group[1] ?? null,
        materialType: group[3] ?? null,
        refs: summarizeSameMaterialRefs(group[2]),
      };
    }
    return {
      materialCode: group?.materialCode ?? group?.material_code ?? group?.id ?? null,
      color: group?.color ?? null,
      materialType: group?.materialType ?? group?.material_type ?? group?.type ?? null,
      refs: summarizeSameMaterialRefs(group?.refs ?? group?.materials ?? group?.materialRefs),
    };
  });
}

/**
 * CFS `boxsInfo` を timeline 用 summary へ圧縮する。
 *
 * 【詳細説明】
 * - Gate 10 では slot 抜差し、material 変更、external spool、`colorMatch` の変化を見たい。
 * - raw `boxsInfo` 全体は大きく、serial や未確定 firmware field も含み得るため、比較に必要な
 *   box/material/same_material/colorMatch の最小 shape だけを保持する。
 *
 * @private
 * @param {object|null|undefined} boxsInfo - K2 `boxsInfo` payload
 * @returns {object} timeline 用 summary
 */
function summarizeBoxsInfoForTimeline(boxsInfo) {
  const boxes = Array.isArray(boxsInfo?.materialBoxs) ? boxsInfo.materialBoxs : [];
  const colorMatch = Array.isArray(boxsInfo?.colorMatch) ? boxsInfo.colorMatch : [];
  const materialSources = boxes.flatMap((box) => {
    const materials = Array.isArray(box?.materials) ? box.materials : [];
    return materials.map((material) => ({
      boxId: box?.id ?? null,
      boxType: box?.type ?? null,
      boxState: box?.state ?? null,
      materialId: material?.id ?? null,
      state: material?.state ?? null,
      selected: material?.selected ?? null,
      percent: material?.percent ?? null,
      vendor: material?.vendor ?? null,
      name: material?.name ?? null,
      materialType: material?.type ?? null,
      color: material?.color ?? null,
      rfid: material?.rfid ?? null,
      minTemp: material?.minTemp ?? null,
      maxTemp: material?.maxTemp ?? null,
      pressure: material?.pressure ?? null,
      editStatus: material?.editStatus ?? null,
      scrap: material?.scrap ?? null,
    }));
  });
  const sameMaterialGroups = summarizeSameMaterialGroups(boxsInfo?.same_material);
  return {
    enable: boxsInfo?.enable ?? null,
    boxCount: boxes.length,
    materialSourceCount: materialSources.length,
    externalSourceEndpointCount: materialSources.filter((source) => source.boxType === 1).length,
    cfsSourceCount: materialSources.filter((source) => source.boxType !== 1).length,
    sameMaterialGroupCount: sameMaterialGroups.length,
    colorMatchCount: colorMatch.length,
    colorMatch: colorMatch.map((assignment) => ({
      id: assignment?.id ?? null,
      boxId: assignment?.boxId ?? null,
      materialId: assignment?.materialId ?? null,
    })),
    materialSources,
    sameMaterialGroups,
  };
}

/**
 * timeline record に保存してよい値へ正規化する。
 *
 * 【詳細説明】
 * - raw payload を丸ごと保存すると fixture report が肥大化し、CFS の詳細 payload も混ざる。
 * - Gate 9 では print lifecycle の root scalar を追跡することが目的なので、scalar はそのまま保持し、
 *   object / array は構造だけが分かる短い summary に圧縮する。
 * - 例外として `boxsInfo` は Gate 10 の物理 topology 変化を読むため、material source と assignment の
 *   圧縮 summary へ変換する。
 *
 * @private
 * @param {*} value - protocol payload value
 * @param {string=} key - payload key
 * @returns {*} timeline 用に正規化した値
 */
function normalizeTimelineValue(value, key = "") {
  if (key === "boxsInfo") {
    return summarizeBoxsInfoForTimeline(value);
  }
  if (value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value).sort(),
    };
  }
  return String(value);
}

/**
 * timeline snapshot の比較用 signature を作る。
 *
 * 【詳細説明】
 * - delta frame を前回状態へ畳み込んだ後の snapshot を比較し、変化がない frame を report から省く。
 *
 * @private
 * @param {object} snapshot - timeline snapshot
 * @returns {string} 比較用 signature
 */
function createTimelineSignature(snapshot) {
  const ordered = {};
  for (const key of Object.keys(snapshot).sort()) {
    ordered[key] = snapshot[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Protocol event 群から payload timeline を作る。
 *
 * 【詳細説明】
 * - K1/K2 は delta payload を送ることがあるため、観測した key を前回 snapshot に merge しながら時系列化する。
 * - marker と outbound request は timeline 対象外にし、受信 frame の root / result / data envelope だけを見る。
 * - 連続して同一 snapshot になる frame は捨て、state 変化や progress 変化を読むための短い report にする。
 *
 * @private
 * @param {Array<object>} events - ProtocolRecorder event 一覧
 * @param {string[]} timelinePayloadKeys - timeline に含める payload key 一覧
 * @returns {object} timeline report
 */
function createPayloadTimeline(events, timelinePayloadKeys) {
  const keys = uniqueStringList(normalizeStringList(timelinePayloadKeys));
  const entries = [];
  const currentSnapshot = {};
  let previousSignature = createTimelineSignature(currentSnapshot);

  if (keys.length === 0) {
    return {
      keys,
      entries,
    };
  }

  for (const event of events) {
    if (!event || event.direction !== "in") {
      continue;
    }
    const body = unwrapProtocolEnvelope(extractEventPayloadBody(event));
    if (!body || typeof body !== "object") {
      continue;
    }

    const changedKeys = [];
    for (const key of keys) {
      if (!hasOwn(body, key)) {
        continue;
      }
      const nextValue = normalizeTimelineValue(body[key], key);
      const before = createTimelineSignature({ value: currentSnapshot[key] });
      const after = createTimelineSignature({ value: nextValue });
      currentSnapshot[key] = nextValue;
      if (before !== after) {
        changedKeys.push(key);
      }
    }

    if (changedKeys.length === 0) {
      continue;
    }

    const signature = createTimelineSignature(currentSnapshot);
    if (signature === previousSignature) {
      continue;
    }
    previousSignature = signature;
    entries.push({
      sequence: event.sequence ?? null,
      atMs: Number.isFinite(event.atMs) ? event.atMs : null,
      changedKeys,
      state: { ...currentSnapshot },
    });
  }

  return {
    keys,
    entries,
  };
}

/**
 * profile と個別 options を scenario 解析条件へ合成する。
 *
 * 【詳細説明】
 * - profile は標準条件をまとめるためのものであり、CLI の明示 `expectedScenario` は profile の既定値を上書きする。
 * - marker / payload key は profile 条件へ個別指定を追加し、重複は最初の出現を採用する。
 *
 * @private
 * @param {object} options - analyzeProtocolScenarioFixture の options
 * @returns {object} 合成済み解析条件
 */
function createScenarioAnalysisRequirements(options) {
  const profileNames = normalizeStringList(options.profiles);
  const profiles = [];
  const unknownProfiles = [];

  for (const profileName of profileNames) {
    const profile = getProtocolScenarioProfile(profileName);
    if (profile) {
      profiles.push(profile);
    } else {
      unknownProfiles.push(profileName);
    }
  }

  const profileMarkers = profiles.flatMap((profile) => profile.requiredMarkers);
  const profilePayloadKeys = profiles.flatMap((profile) => profile.requiredPayloadKeys);
  const profileTimelineKeys = profiles.flatMap((profile) => profile.timelinePayloadKeys || []);
  const profileExpectedScenario = profiles.find((profile) => profile.expectedScenario)?.expectedScenario || "";
  const profileRequiresValidation = profiles.some((profile) => profile.requireValidationSuccess);

  return {
    profiles: profiles.map((profile) => profile.name),
    unknownProfiles,
    expectedScenario: options.expectedScenario || profileExpectedScenario,
    requireValidationSuccess: options.requireValidationSuccess === true || profileRequiresValidation,
    requiredMarkers: uniqueMarkerRequirements([
      ...normalizeMarkerRequirements(profileMarkers),
      ...normalizeMarkerRequirements(options.requiredMarkers),
    ]),
    requiredPayloadKeys: uniqueStringList([
      ...normalizeStringList(profilePayloadKeys),
      ...normalizeStringList(options.requiredPayloadKeys),
    ]),
    timelinePayloadKeys: uniqueStringList([
      ...normalizeStringList(profileTimelineKeys),
      ...normalizeStringList(options.timelinePayloadKeys),
    ]),
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
 * @param {Array<string>=} options.profiles - 適用する標準 scenario profile 名一覧
 * @param {string=} options.expectedScenario - 期待する scenario 名
 * @param {boolean=} options.requireValidationSuccess - metadata.validation.success を必須にする場合 true
 * @param {Array<string|object>=} options.requiredMarkers - 必須 marker requirement 一覧
 * @param {Array<string>=} options.requiredPayloadKeys - 必須 payload key 一覧
 * @param {Array<string>=} options.timelinePayloadKeys - payload timeline に含める key 一覧
 * @returns {object} scenario 解析結果
 * @example
 * const report = analyzeProtocolScenarioFixture({ metadata, events }, { requiredMarkers: ["operator-print-start"] });
 */
export function analyzeProtocolScenarioFixture(fixture, options = {}) {
  const metadata = fixture?.metadata && typeof fixture.metadata === "object" ? fixture.metadata : {};
  const events = Array.isArray(fixture?.events) ? fixture.events : [];
  const requirements = createScenarioAnalysisRequirements(options);
  const requiredMarkers = requirements.requiredMarkers;
  const requiredPayloadKeys = requirements.requiredPayloadKeys;
  const markers = events
    .filter((event) => event?.direction === "marker" || event?.kind === "marker")
    .map((event) => summarizeMarker(event));
  const markerReport = analyzeRequiredMarkers(markers, requiredMarkers);
  const payloadReport = analyzeRequiredPayloadKeys(events, requiredPayloadKeys);
  const payloadTimeline = createPayloadTimeline(events, requirements.timelinePayloadKeys);
  const protocolEventCount = events.filter((event) => event?.direction !== "marker").length;
  const validationCounts = analyzeValidationCounts(
    metadata,
    events.length,
    protocolEventCount,
    markers.length,
  );
  const failureReasons = [];

  if (requirements.unknownProfiles.length > 0) {
    failureReasons.push("unknown-scenario-profile");
  }
  if (requirements.expectedScenario &&
      metadata.capture?.scenario !== requirements.expectedScenario) {
    failureReasons.push("scenario-name-mismatch");
  }
  if (requirements.requireValidationSuccess === true &&
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
  if (!validationCounts.success) {
    failureReasons.push("fixture-event-count-mismatch");
  }

  return {
    schemaVersion: 1,
    success: failureReasons.length === 0,
    failureReasons,
    profiles: {
      applied: requirements.profiles,
      unknown: requirements.unknownProfiles,
    },
    scenario: metadata.capture?.scenario ?? null,
    eventCount: events.length,
    protocolEventCount,
    markerCount: markers.length,
    markers,
    requiredMarkers: markerReport,
    requiredPayloadKeys: payloadReport,
    payloadTimeline,
    validation: {
      success: metadata.validation?.success ?? null,
      failureReasons: Array.isArray(metadata.validation?.failureReasons)
        ? metadata.validation.failureReasons
        : [],
      counts: validationCounts,
    },
  };
}
