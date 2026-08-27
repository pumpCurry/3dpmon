/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 material system 設定正規化モジュール
 * @file dashboard_material_system_settings.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_material_system_settings
 *
 * 【機能内容サマリ】
 * - 接続先ごとの単一スプール/CFS/CFS-C表示設定を正規化
 * - Printer Core v3 material topology の観測状態と手動設定から表示モード/表示台数を決定
 * - material provider はread-only表示用途に限定し、command/ledger authorityと分離
 *
 * 【公開関数一覧】
 * - {@link createDefaultMaterialSystemSettings}：プリンタ種別に応じた既定設定を生成
 * - {@link normalizeMaterialSystemSettings}：保存済み設定を安全なshapeへ正規化
 * - {@link resolveMaterialDisplayMode}：フィラメントパネルの表示方式を決定
 * - {@link resolveMaterialTopologyViewOptions}：表示対象のCFS/CFS-C台数とslot数を決定
 * - {@link resolveDisplayMaterialTopology}：runtime鮮度を反映した表示用topologyを生成
 *
 * @version 1.390.1420 (PR #434)
 * @since   1.390.1362 (PR #432)
 * @lastModified 2026-08-27 15:45:53
 * -----------------------------------------------------------
 * @todo
 * - CFS/CFS-C command authority を有効化するGateで、feed/retract/selectの許可条件を別契約として追加する
 */

"use strict";

/**
 * material system の運用モード一覧。
 *
 * 【詳細説明】
 * - `auto` はPrinter Core v3の観測topologyを優先し、未観測なら従来単一スプールへ戻す。
 * - `single-spool` は手動在庫スプールを1本だけ表示する既存運用を明示する。
 * - `cfs-readonly` / `cfs-c-readonly` は物理CFS系をread-only監視対象として固定表示する。
 * - CFS/CFS-C台数は別の `unitLimit` で管理し、0台なら従来単一スプール運用として扱う。
 *
 * @enum {string}
 */
export const MATERIAL_SYSTEM_MODE = Object.freeze({
  AUTO: "auto",
  SINGLE_SPOOL: "single-spool",
  CFS_READONLY: "cfs-readonly",
  CFS_C_READONLY: "cfs-c-readonly",
});

/**
 * フィラメントパネルの表示モード一覧。
 *
 * 【詳細説明】
 * - 表示の手動overrideを保存するため、material system modeとは別に保持する。
 *
 * @enum {string}
 */
export const MATERIAL_DISPLAY_MODE = Object.freeze({
  AUTO: "auto",
  LEGACY_CARD: "legacy-card",
  MULTI_SLOT: "multi-slot",
});

/**
 * material topology の取得provider指定一覧。
 *
 * 【詳細説明】
 * - 現Gateではprovider選択は表示契約の記録だけであり、通信経路やcommand権限は変更しない。
 *
 * @enum {string}
 */
export const MATERIAL_PROVIDER_MODE = Object.freeze({
  AUTO: "auto",
  K2_BOXS_INFO: "k2-boxsInfo",
  MOONRAKER_BOXS_INFO: "moonraker-boxsInfo",
  NONE: "none",
});

/**
 * CFS/CFS-Cとして設定できる最大ユニット数。
 *
 * 【詳細説明】
 * - 1台あたり4slot、最大4台で16slot、外部スプール1本を加えて17巻表示まで扱う。
 *
 * @constant {number}
 */
export const MAX_MATERIAL_UNIT_COUNT = 4;

/**
 * CFS/CFS-C 1ユニットあたりのslot数。
 *
 * 【詳細説明】
 * - Creality CFS UIのA-D表示に合わせ、1unit=4slotで固定する。
 *
 * @constant {number}
 */
export const MATERIAL_SLOTS_PER_UNIT = 4;

/**
 * 外部スプール表示数。
 *
 * 【詳細説明】
 * - 現行運用ではCFS台数にかかわらず外部スプールは1本だけを表示対象にする。
 *
 * @constant {number}
 */
export const MATERIAL_EXTERNAL_SOURCE_LIMIT = 1;

/**
 * material topology を「現在値」と見なす最大経過時間。
 *
 * 【詳細説明】
 * - CFS/CFS-Cの装填/選択/残量は人間が監視する情報なので、通信停止後もfresh表示のまま残すと
 *   「現在選択中」と誤読される。K2のboxsInfo probeは10秒周期、応答待ちtimeoutは25秒なので、
 *   stale表示へ落ちる前に複数回の取得機会を持てる45秒を採用する。
 *
 * @constant {number}
 */
export const MATERIAL_TOPOLOGY_FRESH_TTL_MS = 45_000;

/**
 * 配列内の許可値に一致する文字列だけを返す。
 *
 * 【詳細説明】
 * - 古いlocalStorageや手編集された設定が混じっても、UI分岐が未知値に引きずられないようにする。
 *
 * @private
 * @param {*} value - 保存値候補
 * @param {string[]} allowedValues - 許可する値
 * @param {string} fallback - 不正値時のfallback
 * @returns {string} 正規化済み値
 */
function normalizeEnumValue(value, allowedValues, fallback) {
  return allowedValues.includes(value) ? value : fallback;
}

/**
 * CFS/CFS-C台数を0-4へ丸める。
 *
 * 【詳細説明】
 * - 接続設定の値は手入力や旧localStorage由来になるため、表示枠数の暴走をここで止める。
 *
 * @private
 * @param {*} value - 台数候補
 * @param {number} fallback - 不正値時のfallback
 * @returns {number} 0-4の整数
 */
function normalizeUnitLimit(value, fallback) {
  const numeric = Number(value);
  const source = Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
  return Math.max(0, Math.min(MAX_MATERIAL_UNIT_COUNT, source));
}

/**
 * topologyから観測済みCFS/CFS-Cユニット数を推定する。
 *
 * 【詳細説明】
 * - 明示設定がautoの場合でも、実際に1台だけ観測している機器へ16slot全部を出さないために使う。
 *
 * @private
 * @param {object|null|undefined} topology - Normalized material topology
 * @returns {number} 観測済みunit数
 */
function countObservedMaterialUnits(topology) {
  if (!topology || typeof topology !== "object") {
    return 0;
  }
  let maxPhysicalUnitIndex = 0;
  if (Array.isArray(topology.units) && topology.units.length > 0) {
    for (const unit of topology.units) {
      const boxId = Number(unit?.boxId);
      if (Number.isInteger(boxId) && boxId >= 1 && boxId <= MAX_MATERIAL_UNIT_COUNT) {
        maxPhysicalUnitIndex = Math.max(maxPhysicalUnitIndex, boxId);
      }
    }
    if (maxPhysicalUnitIndex > 0) {
      return maxPhysicalUnitIndex;
    }
    return Math.min(MAX_MATERIAL_UNIT_COUNT, topology.units.length);
  }
  const unitIds = new Set();
  for (const source of Array.isArray(topology.sources) ? topology.sources : []) {
    const boxId = Number(source?.boxId);
    if (Number.isInteger(boxId) && boxId >= 1 && boxId <= MAX_MATERIAL_UNIT_COUNT) {
      maxPhysicalUnitIndex = Math.max(maxPhysicalUnitIndex, boxId);
    }
    if (source?.kind === "cfs-slot" && source.unitId) {
      unitIds.add(source.unitId);
    }
  }
  if (maxPhysicalUnitIndex > 0) {
    return maxPhysicalUnitIndex;
  }
  return Math.min(MAX_MATERIAL_UNIT_COUNT, unitIds.size);
}

/**
 * プリンタ種別に対応するmaterial system既定値を返す。
 *
 * 【詳細説明】
 * - K2はCFSを持つ可能性が高いため、topology観測時に自動で多スロットへ移れる設定にする。
 * - K1/Moonrakerは既存単一スプール運用を初期表示にし、K1C+CFS-Cは設定画面で明示切替する。
 *
 * @function createDefaultMaterialSystemSettings
 * @param {"creality-k1"|"creality-k2"|"moonraker"|string=} printerType - 接続先プリンタ種別
 * @returns {object} material system設定
 * @example
 * const settings = createDefaultMaterialSystemSettings("creality-k2");
 */
export function createDefaultMaterialSystemSettings(printerType = "creality-k1") {
  const defaultUnitLimit = printerType === "creality-k2" ? 1 : 0;
  return {
    mode: printerType === "creality-k2"
      ? MATERIAL_SYSTEM_MODE.AUTO
      : MATERIAL_SYSTEM_MODE.SINGLE_SPOOL,
    displayMode: MATERIAL_DISPLAY_MODE.AUTO,
    provider: MATERIAL_PROVIDER_MODE.AUTO,
    providerEndpoint: "",
    unitLimit: defaultUnitLimit,
    slotsPerUnit: MATERIAL_SLOTS_PER_UNIT,
    externalSourceLimit: MATERIAL_EXTERNAL_SOURCE_LIMIT,
    readOnly: true,
    canSendCommands: false,
    canDriveLedger: false,
  };
}

/**
 * 保存済みmaterial system設定を安全なshapeへ正規化する。
 *
 * 【詳細説明】
 * - 接続先設定はlocalStorage由来のため、未知キーや旧形式が含まれる前提で防御する。
 * - 表示台数は0-4unitへ丸める。0unitは通常の手動1巻運用を意味する。
 *
 * @function normalizeMaterialSystemSettings
 * @param {object|null|undefined} settings - 保存済み設定
 * @param {"creality-k1"|"creality-k2"|"moonraker"|string=} printerType - 接続先プリンタ種別
 * @returns {object} 正規化済みmaterial system設定
 * @example
 * const normalized = normalizeMaterialSystemSettings(target.materialSystem, target.printerType);
 */
export function normalizeMaterialSystemSettings(settings, printerType = "creality-k1") {
  const defaults = createDefaultMaterialSystemSettings(printerType);
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    mode: normalizeEnumValue(
      source.mode,
      Object.values(MATERIAL_SYSTEM_MODE),
      defaults.mode
    ),
    displayMode: normalizeEnumValue(
      source.displayMode,
      Object.values(MATERIAL_DISPLAY_MODE),
      defaults.displayMode
    ),
    provider: normalizeEnumValue(
      source.provider,
      Object.values(MATERIAL_PROVIDER_MODE),
      defaults.provider
    ),
    providerEndpoint: typeof source.providerEndpoint === "string"
      ? source.providerEndpoint.trim()
      : defaults.providerEndpoint,
    unitLimit: normalizeUnitLimit(source.unitLimit, defaults.unitLimit),
    slotsPerUnit: Math.max(0, Math.min(MATERIAL_SLOTS_PER_UNIT, Number.isFinite(Number(source.slotsPerUnit)) ? Math.floor(Number(source.slotsPerUnit)) : defaults.slotsPerUnit)),
    externalSourceLimit: Math.max(0, Math.min(MATERIAL_EXTERNAL_SOURCE_LIMIT, Number.isFinite(Number(source.externalSourceLimit)) ? Math.floor(Number(source.externalSourceLimit)) : defaults.externalSourceLimit)),
    readOnly: true,
    canSendCommands: false,
    canDriveLedger: false,
  };
}

/**
 * material topologyの観測時刻をepoch msへ変換する。
 *
 * 【詳細説明】
 * - live shadow recordの `lastObservedAt` と topology provider metadata の双方を扱う。
 * - 日付文字列が不正な場合は `null` にし、fresh判定へ使わない。
 *
 * @private
 * @param {*} value - ISO日時、epoch ms、または不正値
 * @returns {number|null} epoch ms、判断不能なら null
 */
function parseObservedAtMs(value) {
  if (value == null || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * runtime鮮度を反映した表示用material topologyを返す。
 *
 * 【詳細説明】
 * - live shadowがclosed、または最後の観測からTTLを超えた場合、topology自体は残しつつ
 *   `cfs.topologyState:"stale"` と診断を付ける。これにより「最後に観測したslot/残量」を
 *   現在値と誤認しない表示へ切り替えられる。
 * - 返値は表示専用の浅いcloneで、runtimeDataに保存された証拠topologyは書き換えない。
 *
 * @function resolveDisplayMaterialTopology
 * @param {object} options - 表示用topology生成オプション
 * @param {object|null|undefined} options.topology - runtimeData上のNormalized material topology
 * @param {object|null|undefined} options.shadowRecord - runtimeData.printerCoreV3Shadow record
 * @param {number=} options.nowMs - 現在時刻epoch ms
 * @param {number=} options.ttlMs - freshと見なす最大経過時間
 * @returns {object|null} 表示用topology、未観測なら null
 * @example
 * const displayTopology = resolveDisplayMaterialTopology({ topology, shadowRecord });
 */
export function resolveDisplayMaterialTopology({
  topology = null,
  shadowRecord = null,
  nowMs = Date.now(),
  ttlMs = MATERIAL_TOPOLOGY_FRESH_TTL_MS,
} = {}) {
  if (!topology || typeof topology !== "object") {
    return null;
  }
  const observedAtMs = parseObservedAtMs(
    topology.provider?.lastObservedAt ??
    shadowRecord?.materialProviderLastObservedAt ??
    topology.source?.receivedAt ??
    shadowRecord?.lastObservedAt
  );
  const alreadyStale = topology.cfs?.topologyState === "stale";
  const closed = shadowRecord?.state === "closed";
  if (observedAtMs == null && !closed && !alreadyStale) {
    return null;
  }
  const expired = observedAtMs == null || (Number.isFinite(nowMs) && nowMs - observedAtMs > ttlMs);
  if (!closed && !expired && !alreadyStale) {
    return topology;
  }
  const diagnostics = Array.isArray(topology.diagnostics) ? topology.diagnostics.slice() : [];
  const hasFreshnessDiagnostic = diagnostics.some((entry) => entry?.code === "material-topology-stale");
  if (!hasFreshnessDiagnostic) {
    diagnostics.push({
      code: "material-topology-stale",
      severity: "warn",
      message: closed
        ? "CFS/CFS-C connection is closed; values are last observed."
        : "CFS/CFS-C topology observation is stale; values are last observed.",
      lastObservedAt: observedAtMs != null ? new Date(observedAtMs).toISOString() : null,
    });
  }
  return {
    ...topology,
    cfs: {
      ...(topology.cfs || {}),
      connected: false,
      topologyState: "stale",
    },
    provider: {
      ...(topology.provider || {}),
      freshness: "stale",
    },
    diagnostics,
  };
}

/**
 * topologyが多スロット表示に使える観測情報を持つか判定する。
 *
 * 【詳細説明】
 * - CFS切断中のstale topologyも、抜き差しや未選択状態の観察に使うため多スロット表示対象に含める。
 *
 * @private
 * @param {object|null|undefined} topology - Normalized material topology
 * @returns {boolean} 多スロット表示に使える場合 true
 */
function hasObservedMaterialTopology(topology) {
  if (!topology || typeof topology !== "object") {
    return false;
  }
  const hasSources = Array.isArray(topology.sources) && topology.sources.length > 0;
  const hasUnits = Array.isArray(topology.units) && topology.units.length > 0;
  const hasProvider = topology.provider && typeof topology.provider === "object";
  const topologyState = topology.cfs?.topologyState;
  return Boolean(hasSources || hasUnits || hasProvider || topologyState === "fresh" || topologyState === "stale");
}

/**
 * フィラメントパネルで使う表示方式を決定する。
 *
 * 【詳細説明】
 * - 明示的なdisplayModeがある場合はそれを優先する。
 * - material systemがCFS/CFS-C read-only固定なら、topology未観測でも設定台数ぶんの固定枠を表示する。
 * - autoではCFS/CFS-C台数設定または実topology観測がある時だけmulti-slotへ切り替え、K1の既存単一スプールUIを維持する。
 *
 * @function resolveMaterialDisplayMode
 * @param {object} options - 判定入力
 * @param {object|null|undefined} options.target - connectionTargetsの対象エントリ
 * @param {"creality-k1"|"creality-k2"|"moonraker"|string=} options.printerType - 接続先プリンタ種別
 * @param {object|null|undefined} options.topology - Normalized material topology
 * @returns {"legacy-card"|"multi-slot"} フィラメントパネルの表示方式
 * @example
 * const mode = resolveMaterialDisplayMode({ target, printerType, topology });
 */
export function resolveMaterialDisplayMode({ target, printerType = "creality-k1", topology = null } = {}) {
  const settings = normalizeMaterialSystemSettings(target?.materialSystem, target?.printerType || printerType);
  if (settings.displayMode === MATERIAL_DISPLAY_MODE.LEGACY_CARD) {
    return MATERIAL_DISPLAY_MODE.LEGACY_CARD;
  }
  if (settings.displayMode === MATERIAL_DISPLAY_MODE.MULTI_SLOT) {
    return settings.unitLimit > 0 || hasObservedMaterialTopology(topology)
      ? MATERIAL_DISPLAY_MODE.MULTI_SLOT
      : MATERIAL_DISPLAY_MODE.LEGACY_CARD;
  }
  if (
    (settings.mode === MATERIAL_SYSTEM_MODE.CFS_READONLY ||
      settings.mode === MATERIAL_SYSTEM_MODE.CFS_C_READONLY) &&
    settings.unitLimit > 0
  ) {
    return MATERIAL_DISPLAY_MODE.MULTI_SLOT;
  }
  if (settings.mode === MATERIAL_SYSTEM_MODE.SINGLE_SPOOL) {
    return MATERIAL_DISPLAY_MODE.LEGACY_CARD;
  }
  if (settings.mode === MATERIAL_SYSTEM_MODE.AUTO && settings.unitLimit > 0) {
    return MATERIAL_DISPLAY_MODE.MULTI_SLOT;
  }
  return hasObservedMaterialTopology(topology)
    ? MATERIAL_DISPLAY_MODE.MULTI_SLOT
    : MATERIAL_DISPLAY_MODE.LEGACY_CARD;
}

/**
 * material topology view modelへ渡す表示オプションを決定する。
 *
 * 【詳細説明】
 * - 手動設定のCFS/CFS-C台数を最優先し、未設定autoでは観測済みunit数を使う。
 * - Combo標準の1台構成では5枠、増設4台構成では17枠まで広げる。
 * - 0台設定ではCFS表示へ入らないため、返り値もunitLimit=0になる。
 *
 * @function resolveMaterialTopologyViewOptions
 * @param {object} options - 判定入力
 * @param {object|null|undefined} options.target - connectionTargetsの対象エントリ
 * @param {"creality-k1"|"creality-k2"|"moonraker"|string=} options.printerType - 接続先プリンタ種別
 * @param {object|null|undefined} options.topology - Normalized material topology
 * @returns {object} createMaterialTopologyViewModelへ渡す表示オプション
 * @example
 * const viewOptions = resolveMaterialTopologyViewOptions({ target, printerType, topology });
 */
export function resolveMaterialTopologyViewOptions({ target, printerType = "creality-k1", topology = null } = {}) {
  const settings = normalizeMaterialSystemSettings(target?.materialSystem, target?.printerType || printerType);
  const observedUnitCount = countObservedMaterialUnits(topology);
  const configuredUnitCount = normalizeUnitLimit(settings.unitLimit, printerType === "creality-k2" ? 1 : 0);
  const unitLimit = settings.mode === MATERIAL_SYSTEM_MODE.AUTO
    ? Math.max(configuredUnitCount, observedUnitCount)
    : configuredUnitCount;
  return {
    unitLimit,
    slotsPerUnit: settings.slotsPerUnit,
    externalSourceLimit: settings.externalSourceLimit,
  };
}
