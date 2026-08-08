/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 機体識別モジュール
 * @file dashboard_device_identity.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_device_identity
 *
 * 【機能内容サマリ】
 * - 実機 Probe や Protocol Fixture から得た識別材料を正規化
 * - serial / stable machine id を優先し、MAC は endpoint alias として扱う
 * - 有線LANと無線LANで MAC が異なる同一プリンタを分割しないための判定材料を提供
 *
 * 【公開関数一覧】
 * - {@link normalizeMacAddress}：MAC 表記を区切り付き小文字へ正規化
 * - {@link normalizeIdentityEvidence}：Probe 由来の識別材料を標準形へ変換
 * - {@link createDeviceFingerprint}：/info と WS9999 由来の識別証拠を fingerprint へ変換
 * - {@link createDeviceIdentityCandidate}：deviceId seed と endpoint alias を生成
 * - {@link shouldMergeDeviceIdentity}：二つの識別候補を同一物理機として統合できるか判定
 * - {@link mergeDeviceIdentityCandidate}：二つの識別候補を決定的に統合
 *
 * @version 1.390.1337 (PR #432)
 * @since   1.390.1290 (PR #432)
 * @lastModified 2026-08-09 01:40:00
 * -----------------------------------------------------------
 * @todo
 * - Gate 3 以降で authoritative deviceId 生成を hash ベースへ移行する
 */

"use strict";

/**
 * 強い識別材料がない場合に付ける暫定 prefix。
 *
 * 【詳細説明】
 * - hostname や IP だけの機体は後続 Probe で serial が取得できた時点で alias merge する。
 *
 * @constant {string}
 */
export const PROVISIONAL_DEVICE_PREFIX = "provisional";

/**
 * MAC アドレスとして受け付ける正規表現。
 *
 * 【詳細説明】
 * - Creality の `/info` は区切りなし 12 桁 HEX を返すことがある。
 * - 一般的なコロン区切り・ハイフン区切りも同じ値へ正規化する。
 *
 * @constant {RegExp}
 */
const MAC_FORMAT_PATTERN = /^(?:[0-9a-f]{12}|[0-9a-f]{2}(?::[0-9a-f]{2}){5}|[0-9a-f]{2}(?:-[0-9a-f]{2}){5})$/i;

/**
 * identity 強度の順位。
 *
 * 【詳細説明】
 * - 後から serial が観測された場合、stableMachineId や provisional seed から昇格できるようにする。
 * - unknown は外部から壊れた値が入った場合の安全な最下位として扱う。
 *
 * @constant {object}
 */
const IDENTITY_STRENGTH_RANK = Object.freeze({
  unknown: -1,
  provisional: 0,
  "stable-machine-id": 1,
  serial: 2,
});

/**
 * DeviceFingerprint の schema version。
 *
 * 【詳細説明】
 * - Gate 11 ではまだ Data Schema v3 の永続 store を作らず、identity candidate 内へ同居させる。
 * - 後続 migration で fingerprint を正式 store へ移すとき、同居データの形を判別できるようにする。
 *
 * @constant {number}
 */
export const DEVICE_FINGERPRINT_SCHEMA_VERSION = 1;

/**
 * identity 値を比較用の標準形へ変換する。
 *
 * 【詳細説明】
 * - serial や stableMachineId は大文字小文字の揺れで別機体扱いしない。
 * - Unicode の互換文字差も NFKC で寄せる。
 *
 * @private
 * @param {*} value - 入力値
 * @returns {?string} 標準化された identity 値、または null
 */
function normalizeIdentityValue(value) {
  const normalized = String(value || "").normalize("NFKC").trim().toLowerCase();
  return normalized || null;
}

/**
 * ID seed 用に文字列を安全な部品へ変換する。
 *
 * 【詳細説明】
 * - deviceId はここでは最終 UUID ではなく、決定的 hash の入力 seed として扱う。
 * - 記号をハイフンへ潰すと `ABC/123` と `ABC:123` が衝突し得るため、percent-encoding で
 *   入力差分を残す。
 *
 * @private
 * @param {*} value - 入力値
 * @returns {string} 正規化済み ID 部品
 */
function normalizeIdentityPart(value) {
  const normalized = normalizeIdentityValue(value);
  return normalized ? encodeURIComponent(normalized) : "";
}

/**
 * 重複を除いてソートした配列を返す。
 *
 * 【詳細説明】
 * - MAC alias や endpoint address は順序に意味を持たせず、比較しやすい決定的配列にする。
 *
 * @private
 * @param {Array<*>} values - 入力配列
 * @returns {string[]} 文字列化・重複除去・ソート済み配列
 */
function uniqueSortedStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))).sort();
}

/**
 * 文字列化可能な数値を有限な number へ変換する。
 *
 * 【詳細説明】
 * - `/info` の `wssPort` / `videoPort` は number で返る想定だが、fixture や手入力では
 *   文字列になることもあるため、正規化時点で表記揺れを潰す。
 *
 * @private
 * @param {*} value - 数値候補
 * @returns {?number} 有限な数値、または null
 */
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/**
 * evidence が意味のある HTTP /info transport key を持つか判定する。
 *
 * 【詳細説明】
 * - repository helper は未観測値を `undefined` の property として渡すことがある。
 * - property が存在するだけで HTTP /info と誤推定すると、WS9999 status frame の provenance が
 *   `http-info` に化けるため、空値ではなく実値がある場合だけ true にする。
 *
 * @private
 * @param {object} source - Probe または fixture metadata 由来の識別材料
 * @param {string} key - 検査する key
 * @returns {boolean} key が意味のある値を持つ場合 true
 */
function hasMeaningfulInfoKey(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key) &&
    source[key] !== undefined &&
    source[key] !== null &&
    source[key] !== "";
}

/**
 * evidence の取得元を推定する。
 *
 * 【詳細説明】
 * - HTTP `/info` は `version` / `wssPort` / `videoPort` を持つため、WS9999 payload と区別しやすい。
 * - 呼び出し側が `source` または `observedVia` を渡した場合はその値を優先し、capture tool 側の
 *   provenance を壊さない。
 *
 * @private
 * @param {object} source - Probe または fixture metadata 由来の識別材料
 * @returns {string} fingerprint source
 */
function inferFingerprintSource(source) {
  const explicitSource = String(source.source || source.observedVia || source.protocolSource || "").trim();
  if (explicitSource) {
    return explicitSource;
  }
  if (hasMeaningfulInfoKey(source, "version") ||
      hasMeaningfulInfoKey(source, "firmwareVersion") ||
      hasMeaningfulInfoKey(source, "wssPort") ||
      hasMeaningfulInfoKey(source, "videoPort")) {
    return "http-info";
  }
  if (Object.prototype.hasOwnProperty.call(source, "hostname") ||
      Object.prototype.hasOwnProperty.call(source, "reportedHostname") ||
      Object.prototype.hasOwnProperty.call(source, "deviceState") ||
      Object.prototype.hasOwnProperty.call(source, "state")) {
    return "ws9999";
  }
  return "unknown";
}

/**
 * MAC アドレス表記を正規化する。
 *
 * 【詳細説明】
 * - `AA1122334455`、`AA:11:22:33:44:55`、`aa-11-22-33-44-55` を同じ
 *   `aa:11:22:33:44:55` として扱う。
 * - 無効値は null を返し、呼び出し側で識別材料として使わない。
 *
 * @function normalizeMacAddress
 * @param {*} value - MAC 候補値
 * @returns {?string} 正規化 MAC、または null
 * @example
 * const mac = normalizeMacAddress("AA1122334455");
 */
export function normalizeMacAddress(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!MAC_FORMAT_PATTERN.test(trimmed)) {
    return null;
  }
  const hex = trimmed.replace(/[:-]/g, "");
  return hex.match(/.{1,2}/g).join(":");
}

/**
 * Probe 由来の識別材料を標準形へ変換する。
 *
 * 【詳細説明】
 * - serial と stableMachineId は物理機体の強い識別材料として保持する。
 * - MAC は endpoint に紐付く alias として保持し、単独では物理機体の確定IDにしない。
 * - 有線・無線など複数 NIC の MAC は同じ `macAliases` 配列へ集約する。
 *
 * @function normalizeIdentityEvidence
 * @param {object} evidence - Probe または fixture metadata 由来の識別材料
 * @param {string=} evidence.serialNumber - serial 候補
 * @param {string=} evidence.stableMachineId - 機体が報告する安定ID候補
 * @param {string=} evidence.reportedModel - 機体が報告したモデル名またはモデルコード
 * @param {string=} evidence.reportedHostname - 機体が報告した hostname
 * @param {string=} evidence.endpointAddress - 接続元 endpoint の IP / host
 * @param {string=} evidence.macAddress - MAC 候補
 * @param {string[]=} evidence.macAliases - 追加 MAC 候補
 * @returns {object} 標準化された識別材料
 * @example
 * const normalized = normalizeIdentityEvidence({ serialNumber: "SERIAL-001", macAddress: "AA1122334455" });
 */
export function normalizeIdentityEvidence(evidence) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const serialNumber = normalizeIdentityValue(source.serialNumber || source.sn);
  const stableMachineId = normalizeIdentityValue(source.stableMachineId || source.machineId || source.deviceId);
  const reportedModel = String(source.reportedModel || source.model || "").trim() || null;
  const reportedHostname = String(source.reportedHostname || source.hostname || "").trim() || null;
  const endpointAddress = String(source.endpointAddress || source.address || source.ip || "").trim() || null;
  const firmwareVersion = String(source.firmwareVersion || source.version || "").trim() || null;
  const wssPort = toFiniteNumberOrNull(source.wssPort);
  const videoPort = toFiniteNumberOrNull(source.videoPort);
  const fingerprintSource = inferFingerprintSource(source);
  const macCandidates = [
    source.macAddress,
    source.mac,
    ...(Array.isArray(source.macAliases) ? source.macAliases : []),
  ];
  const macAliases = uniqueSortedStrings(macCandidates
    .map((value) => normalizeMacAddress(value))
    .filter(Boolean));

  return {
    serialNumber,
    stableMachineId,
    reportedModel,
    reportedHostname,
    endpointAddress,
    firmwareVersion,
    wssPort,
    videoPort,
    fingerprintSource,
    macAliases,
  };
}

/**
 * /info と WS9999 由来の識別証拠を DeviceFingerprint へ変換する。
 *
 * 【詳細説明】
 * - DeviceFingerprint は「この endpoint で観測した識別材料」を表し、deviceId そのものではない。
 * - 有線/無線 MAC は `endpointAliases.macs` に集約し、物理機 identity の seed には使わない。
 * - `http-info` 由来の model/version/port と、WS9999 由来の hostname/model を同じ形に寄せることで、
 *   Gate 11 以降の Data Schema v3 migration が機械的に行えるようにする。
 *
 * @function createDeviceFingerprint
 * @param {object} evidence - Probe または fixture metadata 由来の識別材料
 * @returns {object} 正規化済み DeviceFingerprint
 * @example
 * const fingerprint = createDeviceFingerprint({ model: "F012", sn: "SERIAL-001", version: "1.0.0" });
 */
export function createDeviceFingerprint(evidence) {
  const normalized = normalizeIdentityEvidence(evidence);
  return {
    schemaVersion: DEVICE_FINGERPRINT_SCHEMA_VERSION,
    sources: uniqueSortedStrings([normalized.fingerprintSource]),
    strong: {
      serialNumber: normalized.serialNumber,
      stableMachineId: normalized.stableMachineId,
    },
    reported: {
      model: normalized.reportedModel,
      hostname: normalized.reportedHostname,
      firmwareVersion: normalized.firmwareVersion,
    },
    endpointAliases: {
      addresses: uniqueSortedStrings([normalized.endpointAddress]),
      macs: normalized.macAliases,
    },
    transports: {
      httpInfoObserved: normalized.fingerprintSource === "http-info",
      ws9999Observed: normalized.fingerprintSource === "ws9999",
      wssPort: normalized.wssPort,
      videoPort: normalized.videoPort,
    },
  };
}

/**
 * deviceId seed と endpoint alias を含む識別候補を生成する。
 *
 * 【詳細説明】
 * - serial があれば `serial:<serial>` を seed にする。
 * - stableMachineId があれば `machine:<id>` を seed にする。
 * - どちらも無い場合は `provisional:<model>:<hostname|endpoint>` を使い、後で強い識別材料に
 *   置き換えられる暫定候補として扱う。
 * - MAC は seed へ使わず `endpointAliases.mac` に残す。これは有線/無線で MAC が違う同一機を
 *   別 device と誤認しないためである。
 *
 * @function createDeviceIdentityCandidate
 * @param {object} evidence - Probe または fixture metadata 由来の識別材料
 * @returns {object} device identity candidate
 * @example
 * const candidate = createDeviceIdentityCandidate({ serialNumber: "SERIAL-001", macAddress: "AA1122334455" });
 */
export function createDeviceIdentityCandidate(evidence) {
  const normalized = normalizeIdentityEvidence(evidence);
  const deviceFingerprint = createDeviceFingerprint(evidence);
  let seed;
  let strength;
  const reasons = [];

  if (normalized.serialNumber) {
    seed = `serial:${normalizeIdentityPart(normalized.serialNumber)}`;
    strength = "serial";
    reasons.push("serial-number");
  } else if (normalized.stableMachineId) {
    seed = `machine:${normalizeIdentityPart(normalized.stableMachineId)}`;
    strength = "stable-machine-id";
    reasons.push("stable-machine-id");
  } else {
    const modelPart = normalizeIdentityPart(normalized.reportedModel) || "unknown-model";
    const endpointPart = normalizeIdentityPart(normalized.reportedHostname || normalized.endpointAddress) || "unknown-endpoint";
    seed = `${PROVISIONAL_DEVICE_PREFIX}:${modelPart}:${endpointPart}`;
    strength = "provisional";
    reasons.push("provisional-without-strong-id");
  }

  if (normalized.macAliases.length > 0) {
    reasons.push("mac-as-endpoint-alias");
  }

  return {
    deviceIdSeed: seed,
    identityStrength: strength,
    serialNumber: normalized.serialNumber,
    stableMachineId: normalized.stableMachineId,
    reportedModel: normalized.reportedModel,
    reportedHostname: normalized.reportedHostname,
    deviceFingerprint,
    endpointAliases: {
      addresses: uniqueSortedStrings([normalized.endpointAddress]),
      macs: normalized.macAliases,
    },
    evidenceReasons: reasons,
  };
}

/**
 * 二つの DeviceFingerprint を統合する。
 *
 * 【詳細説明】
 * - fingerprint は監査証拠なので、片側だけにある source / endpoint alias / port 情報を落とさない。
 * - canonical な表示値は左側を優先し、配列系は和集合にする。
 *
 * @private
 * @param {object|null|undefined} left - 左側 fingerprint
 * @param {object|null|undefined} right - 右側 fingerprint
 * @returns {object|null} 統合済み fingerprint、または null
 */
function mergeDeviceFingerprint(left, right) {
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;
  return {
    schemaVersion: DEVICE_FINGERPRINT_SCHEMA_VERSION,
    sources: uniqueSortedStrings([
      ...(left.sources || []),
      ...(right.sources || []),
    ]),
    strong: {
      serialNumber: left.strong?.serialNumber || right.strong?.serialNumber || null,
      stableMachineId: left.strong?.stableMachineId || right.strong?.stableMachineId || null,
    },
    reported: {
      model: left.reported?.model || right.reported?.model || null,
      hostname: left.reported?.hostname || right.reported?.hostname || null,
      firmwareVersion: left.reported?.firmwareVersion || right.reported?.firmwareVersion || null,
    },
    endpointAliases: {
      addresses: uniqueSortedStrings([
        ...(left.endpointAliases?.addresses || []),
        ...(right.endpointAliases?.addresses || []),
      ]),
      macs: uniqueSortedStrings([
        ...(left.endpointAliases?.macs || []),
        ...(right.endpointAliases?.macs || []),
      ]),
    },
    transports: {
      httpInfoObserved: Boolean(left.transports?.httpInfoObserved || right.transports?.httpInfoObserved),
      ws9999Observed: Boolean(left.transports?.ws9999Observed || right.transports?.ws9999Observed),
      wssPort: left.transports?.wssPort ?? right.transports?.wssPort ?? null,
      videoPort: left.transports?.videoPort ?? right.transports?.videoPort ?? null,
    },
  };
}

/**
 * 二つの識別候補を同一物理機として統合できるか判定する。
 *
 * 【詳細説明】
 * - serial の一致は強い一致として統合可能にする。
 * - stableMachineId の一致も統合可能にする。
 * - MAC の一致だけでは NIC 単位一致なので weak として返す。呼び出し側は同一物理機の補助証跡には
 *   使えるが、MAC 不一致だけで分割してはならない。
 * - 両方が provisional の場合は、seed 完全一致のみ統合可能にする。
 *
 * @function shouldMergeDeviceIdentity
 * @param {object} left - 左側の識別候補
 * @param {object} right - 右側の識別候補
 * @returns {{merge:boolean, confidence:string, reason:string}} 統合判定
 * @example
 * const decision = shouldMergeDeviceIdentity(a, b);
 */
export function shouldMergeDeviceIdentity(left, right) {
  const a = left || {};
  const b = right || {};
  const serialConflict = a.serialNumber && b.serialNumber && a.serialNumber !== b.serialNumber;
  const stableConflict = a.stableMachineId && b.stableMachineId && a.stableMachineId !== b.stableMachineId;

  if (serialConflict || stableConflict) {
    const reason = serialConflict && stableConflict
      ? "strong-identity-conflict"
      : serialConflict ? "serial-conflict" : "stable-machine-id-conflict";
    return {
      merge: false,
      confidence: "conflict",
      reason,
    };
  }

  if (a.serialNumber && b.serialNumber) {
    return {
      merge: true,
      confidence: "strong",
      reason: "serial-match",
    };
  }

  if (a.stableMachineId && b.stableMachineId) {
    return {
      merge: true,
      confidence: "strong",
      reason: "stable-machine-id-match",
    };
  }

  const leftMacs = new Set(a.endpointAliases?.macs || []);
  const hasMacOverlap = (b.endpointAliases?.macs || []).some((mac) => leftMacs.has(mac));
  if (hasMacOverlap) {
    return {
      merge: true,
      confidence: "weak",
      reason: "endpoint-mac-overlap",
    };
  }

  if (a.identityStrength === "provisional" && b.identityStrength === "provisional") {
    return {
      merge: a.deviceIdSeed === b.deviceIdSeed,
      confidence: a.deviceIdSeed === b.deviceIdSeed ? "weak" : "unknown",
      reason: a.deviceIdSeed === b.deviceIdSeed ? "same-provisional-seed" : "different-provisional-seed",
    };
  }

  return {
    merge: false,
    confidence: "unknown",
    reason: "insufficient-shared-identity",
  };
}

/**
 * 二つの識別候補を決定的に統合する。
 *
 * 【詳細説明】
 * - 強い seed を持つ候補を優先し、endpoint alias は和集合にする。
 * - serial と stableMachineId が片側にしかない場合は保持する。
 * - モデル名や hostname は既存値を優先しつつ、欠けている場合だけ補完する。
 *
 * @function mergeDeviceIdentityCandidate
 * @param {object} left - 左側の識別候補
 * @param {object} right - 右側の識別候補
 * @returns {object} 統合済み識別候補
 * @example
 * const merged = mergeDeviceIdentityCandidate(wired, wireless);
 */
export function mergeDeviceIdentityCandidate(left, right) {
  const a = left || {};
  const b = right || {};
  const rankA = IDENTITY_STRENGTH_RANK[a.identityStrength] ?? IDENTITY_STRENGTH_RANK.unknown;
  const rankB = IDENTITY_STRENGTH_RANK[b.identityStrength] ?? IDENTITY_STRENGTH_RANK.unknown;
  const preferred = rankB > rankA ? b : a;
  const fallback = preferred === a ? b : a;

  return {
    deviceIdSeed: preferred.deviceIdSeed || fallback.deviceIdSeed || null,
    identityStrength: preferred.identityStrength || fallback.identityStrength || "provisional",
    serialNumber: preferred.serialNumber || fallback.serialNumber || null,
    stableMachineId: preferred.stableMachineId || fallback.stableMachineId || null,
    reportedModel: preferred.reportedModel || fallback.reportedModel || null,
    reportedHostname: preferred.reportedHostname || fallback.reportedHostname || null,
    deviceFingerprint: mergeDeviceFingerprint(preferred.deviceFingerprint, fallback.deviceFingerprint),
    endpointAliases: {
      addresses: uniqueSortedStrings([
        ...(preferred.endpointAliases?.addresses || []),
        ...(fallback.endpointAliases?.addresses || []),
      ]),
      macs: uniqueSortedStrings([
        ...(preferred.endpointAliases?.macs || []),
        ...(fallback.endpointAliases?.macs || []),
      ]),
    },
    evidenceReasons: uniqueSortedStrings([
      ...(preferred.evidenceReasons || []),
      ...(fallback.evidenceReasons || []),
      "merged-identity-candidate",
    ]),
  };
}
