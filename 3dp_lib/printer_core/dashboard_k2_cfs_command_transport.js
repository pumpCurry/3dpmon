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
 * - Gate 19 certification専用に、明示opt-in時だけCFS slot操作候補のdry-run planを生成する
 *
 * 【公開関数一覧】
 * - {@link validateK2CfsSlotControlCertificationEvidence}：production CFS slot操作の実機証跡を検証
 * - {@link validateRegisteredK2CfsSlotControlCertificationEvidence}：registry登録済みproduction証跡を検証
 * - {@link createK2CfsCommandTransportPlan}：command request から送信計画を生成
 * - {@link sendK2CfsCommandTransportPlan}：送信計画を注入済みsend hookで順次送信
 *
 * @version 1.390.1445 (PR #435)
 * @since   1.390.1384 (PR #432)
 * @lastModified 2026-08-28 20:35:00
 * -----------------------------------------------------------
 * @todo
 * - K2実機Gateでslot select/load/unload/feed/retractのLAN commandをcertifyしてから追加する
 */

"use strict";

import { getMaterialProtocolColor } from "./dashboard_material_color.js";

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
 * K2/CFS slot操作候補で採用するWS9999 transport profile名。
 *
 * 【詳細説明】
 * - CrealityPrint device UI bundleで観測した `feedInOrOut` 形を、Gate 19のdry-run/live certification候補として扱う。
 * - まだproduction authorityではないため、通常のtransport plan生成ではこのprofileを返さない。
 *
 * @constant {string}
 */
export const K2_CFS_SLOT_CONTROL_CERTIFICATION_TRANSPORT_PROFILE = "k2-ws9999-feed-in-or-out-candidate-v1";

/**
 * 実機certification済みCFS slot操作で採用するWS9999 transport profile名。
 *
 * 【詳細説明】
 * - `feedInOrOut` をproduction commandとして使う場合は、command kindごとの実機証跡を
 *   `certifiedCfsSlotControlCommands` と `certificationEvidence` で明示した時だけこのprofileへ昇格する。
 *
 * @constant {string}
 */
export const K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE = "k2-ws9999-feed-in-or-out-certified-v1";

/**
 * frame送信hookが「ローカル送信またはprotocol受理」として扱えるstatus。
 *
 * 【詳細説明】
 * - `sent` / `submitted` は WebSocket library への書き込み完了までで、プリンタのprotocol ackではない。
 * - `accepted` / `acknowledged` / `ok` / `success` は transport hook がprotocol responseを評価した場合だけ返す。
 *
 * @constant {ReadonlySet<string>}
 */
const K2_CFS_FRAME_ACCEPTED_STATUSES = Object.freeze(new Set([
  "sent",
  "submitted",
  "accepted",
  "acknowledged",
  "ok",
  "success",
]));

/**
 * frame送信hookが明示的な失敗として返すstatus。
 *
 * 【詳細説明】
 * - 明示失敗は次frameへ進めず、certification結果をfalse-positiveにしない。
 *
 * @constant {ReadonlySet<string>}
 */
const K2_CFS_FRAME_REJECTED_STATUSES = Object.freeze(new Set([
  "error",
  "failed",
  "rejected",
  "timeout",
  "transport-error",
  "transient-error",
]));

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
 * このmodule内のfactoryで生成したtransport planだけを記録するWeakSet。
 *
 * 【詳細説明】
 * - 低レベルsenderへcallerが `{ok:true, certificationOnly:false}` 風のplain objectを渡しても、
 *   certification検証済みplanとして扱わないためのmodule-private証跡。
 *
 * @constant {WeakSet<object>}
 */
const TRUSTED_K2_CFS_TRANSPORT_PLANS = new WeakSet();

/**
 * production CFS slot操作を許可するmodule-owned certification registry。
 *
 * 【詳細説明】
 * - connection targetやUI設定に保存された証跡だけでproduction commandを有効化しないため、
 *   実機certificationをコードレビュー済みのimmutable registryとして保持する。
 * - 現時点ではGate 10/12の物理certificationが未完了のため空配列にし、slot操作はfail-closedを維持する。
 * - 将来certificationを追加する場合は、この配列へ完全な証跡を追加し、reviewとlive testを通す。
 *
 * @constant {ReadonlyArray<object>}
 */
export const K2_CFS_SLOT_CONTROL_CERTIFICATION_REGISTRY = Object.freeze([]);

/**
 * 未certified CFS slot commandを `feedInOrOut` 候補へ写す定義。
 *
 * 【詳細説明】
 * - `isFeed:1` と `isFeed:0` の物理意味はGate 19 live captureで確定する。
 * - UI表示語としてのFeed/RetractとCFS装填語としてのLoad/Unloadは同一視しない。
 *
 * @constant {Object<string, object>}
 */
const CFS_SLOT_CONTROL_CANDIDATE_DEFINITIONS = Object.freeze({
  "cfs-slot-select": Object.freeze({
    isFeed: 1,
    candidateOperation: "feed-in-or-select",
    expectedObservation: "selected-source-may-change",
    semanticStatus: "uncertified",
    liveCertificationAllowed: false,
  }),
  "cfs-load": Object.freeze({
    isFeed: 1,
    candidateOperation: "feed-in-or-load",
    expectedObservation: "selected-source-or-feed-state-may-change",
    semanticStatus: "uncertified",
    liveCertificationAllowed: true,
  }),
  "cfs-unload": Object.freeze({
    isFeed: 0,
    candidateOperation: "feed-out-or-unload",
    expectedObservation: "selected-source-or-feed-state-may-change",
    semanticStatus: "uncertified",
    liveCertificationAllowed: true,
  }),
  "cfs-feed": Object.freeze({
    isFeed: 1,
    candidateOperation: "feed-in",
    expectedObservation: "physical-feed-state-may-change",
    semanticStatus: "uncertified",
    liveCertificationAllowed: false,
  }),
  "cfs-retract": Object.freeze({
    isFeed: 0,
    candidateOperation: "feed-out-or-retract",
    expectedObservation: "physical-feed-state-may-change",
    semanticStatus: "uncertified",
    liveCertificationAllowed: false,
  }),
});

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
 * JSONとして安全に保持できる値をcloneする。
 *
 * 【詳細説明】
 * - certification evidenceをtransport plan detailsへ写す際、caller側objectの後続変更が
 *   送信計画の監査証跡を書き換えないようにする。
 *
 * @private
 * @param {*} value - clone対象
 * @returns {*} clone結果
 */
function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * object/arrayを再帰的にfreezeする。
 *
 * 【詳細説明】
 * - transport planはWeakSetでfactory由来を識別しているが、callerが生成後にframesやdetailsを
 *   書き換えるとsend-time validation後の意味が変わってしまう。
 * - 循環参照は想定しないが、防御としてseenを保持し、同じobjectを二度処理しない。
 *
 * @private
 * @function deepFreezeJsonValue
 * @param {*} value - freeze対象
 * @param {WeakSet<object>=} seen - 処理済みobject
 * @returns {*} freeze後の同じ値
 */
function deepFreezeJsonValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreezeJsonValue(child, seen);
  }
  return Object.freeze(value);
}

/**
 * JSON互換値をkey順に正規化して文字列化する。
 *
 * 【詳細説明】
 * - module-owned registryとcaller supplied evidenceの比較で、object property順だけが違う証跡を
 *   誤って別物扱いしないために使う。
 * - undefinedや関数はcertification evidenceとして扱わない前提で、JSON.stringifyと同等に落とす。
 *
 * @private
 * @function stableJsonStringify
 * @param {*} value - JSON互換値
 * @returns {string} key順を安定化したJSON文字列
 */
function stableJsonStringify(value) {
  return JSON.stringify(value, (key, entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    return Object.keys(entry)
      .sort()
      .reduce((result, entryKey) => {
        result[entryKey] = entry[entryKey];
        return result;
      }, {});
  });
}

/**
 * module factory由来のtransport planとして記録する。
 *
 * 【詳細説明】
 * - non-enumerableな印ではなくWeakSetを使い、JSON保存・diff・テストの表示shapeを汚さない。
 *
 * @private
 * @function createTrustedTransportPlan
 * @param {object} plan - transport plan
 * @returns {object} 同じtransport plan
 */
function createTrustedTransportPlan(plan) {
  if (plan && typeof plan === "object") {
    deepFreezeJsonValue(plan);
    TRUSTED_K2_CFS_TRANSPORT_PLANS.add(plan);
  }
  return plan;
}

/**
 * certification evidence 内のcommand kind一覧を正規化する。
 *
 * 【詳細説明】
 * - schemaは `commandKinds` を推奨するが、単一commandの証跡だけを簡潔に書けるよう `commandKind` も読む。
 * - 空文字や重複は比較前に取り除き、production判定へ曖昧な値を残さない。
 *
 * @private
 * @param {object} evidence - certification evidence
 * @returns {Set<string>} command kind set
 */
function normalizeCertificationEvidenceCommandKinds(evidence) {
  const commandKinds = Array.isArray(evidence?.commandKinds)
    ? evidence.commandKinds
    : [evidence?.commandKind];
  return new Set(commandKinds.map((entry) => toNonEmptyString(entry)).filter(Boolean));
}

/**
 * certification evidence のmodel scopeを検査する。
 *
 * 【詳細説明】
 * - 証跡側は単一 `model` または複数 `models` を許可する。
 * - 現在runtime/targetのmodelが未観測なら一致を証明できないため拒否する。
 *
 * @private
 * @param {object} evidence - certification evidence
 * @param {string|null} currentModel - 現在target/runtimeで観測したmodel
 * @returns {boolean} scopeが満たされる場合true
 */
function matchesCertificationModelScope(evidence, currentModel) {
  const evidenceModels = Array.isArray(evidence?.models)
    ? evidence.models
    : [evidence?.model];
  const normalizedModels = new Set(evidenceModels
    .map((entry) => toNonEmptyString(entry)?.toUpperCase())
    .filter(Boolean));
  if (normalizedModels.size === 0) {
    return false;
  }
  const normalizedCurrent = toNonEmptyString(currentModel)?.toUpperCase();
  return normalizedCurrent ? normalizedModels.has(normalizedCurrent) : false;
}

/**
 * certification evidence のfirmware scopeを検査する。
 *
 * 【詳細説明】
 * - 証跡側は単一 `firmwareVersion` または複数 `firmwareVersions` を許可する。
 * - 現在runtime/targetのfirmwareが未観測なら一致を証明できないため拒否する。
 *
 * @private
 * @param {object} evidence - certification evidence
 * @param {string|null} currentFirmwareVersion - 現在target/runtimeで観測したfirmware version
 * @returns {boolean} scopeが満たされる場合true
 */
function matchesCertificationFirmwareScope(evidence, currentFirmwareVersion) {
  const evidenceVersions = Array.isArray(evidence?.firmwareVersions)
    ? evidence.firmwareVersions
    : [evidence?.firmwareVersion];
  const normalizedVersions = new Set(evidenceVersions
    .map((entry) => toNonEmptyString(entry))
    .filter(Boolean));
  if (normalizedVersions.size === 0) {
    return false;
  }
  const normalizedCurrent = toNonEmptyString(currentFirmwareVersion);
  return normalizedCurrent ? normalizedVersions.has(normalizedCurrent) : false;
}

/**
 * K2/CFS slot操作のproduction certification evidenceを検証する。
 *
 * 【詳細説明】
 * - 空objectや配列を「証跡あり」と見なさず、command kind・transport profile・K2 printer scope・
 *   model/firmware/capture metadata が揃った場合だけproduction昇格へ使う。
 * - runtime/target側でprinterType/model/firmwareが未観測の場合は、証跡の流用を防ぐため拒否する。
 *
 * @function validateK2CfsSlotControlCertificationEvidence
 * @param {*} evidence - 検証対象のcertification evidence
 * @param {string} commandKind - production昇格したいcommand kind
 * @param {object=} scope - 現在target/runtimeから得たscope
 * @param {string=} scope.printerType - 現在のprinterType
 * @param {string=} scope.model - 現在のmodel code
 * @param {string=} scope.firmwareVersion - 現在のfirmware version
 * @returns {{ok: boolean, errors: string[]}} 検証結果
 * @example
 * const result = validateK2CfsSlotControlCertificationEvidence(evidence, "cfs-load", { printerType: "creality-k2" });
 */
export function validateK2CfsSlotControlCertificationEvidence(evidence, commandKind, scope = {}) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { ok: false, errors: ["evidence-not-object"] };
  }
  if (Number(evidence.schemaVersion) !== 1) {
    errors.push("schema-version-missing");
  }
  if (toNonEmptyString(evidence.status) !== "certified") {
    errors.push("status-not-certified");
  }
  if (toNonEmptyString(evidence.transportProfile) !== K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE) {
    errors.push("transport-profile-mismatch");
  }
  if (toNonEmptyString(evidence.printerType) !== "creality-k2") {
    errors.push("printer-type-not-k2");
  }
  const currentPrinterType = toNonEmptyString(scope?.printerType);
  if (currentPrinterType !== "creality-k2") {
    errors.push("current-printer-type-not-k2");
  }
  const certifiedCommands = normalizeCertificationEvidenceCommandKinds(evidence);
  if (!certifiedCommands.has(commandKind)) {
    errors.push("command-kind-not-certified");
  }
  if (!matchesCertificationModelScope(evidence, scope?.model || scope?.reportedModel)) {
    errors.push("model-scope-missing-or-mismatch");
  }
  if (!matchesCertificationFirmwareScope(evidence, scope?.firmwareVersion || scope?.version || scope?.reportedFirmwareVersion)) {
    errors.push("firmware-scope-missing-or-mismatch");
  }
  if (!toNonEmptyString(evidence.gate)) {
    errors.push("gate-missing");
  }
  if (!toNonEmptyString(evidence.fixtureId)) {
    errors.push("fixture-id-missing");
  }
  if (!toNonEmptyString(evidence.captureId)) {
    errors.push("capture-id-missing");
  }
  if (!toNonEmptyString(evidence.certifiedAt)) {
    errors.push("certified-at-missing");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * K2/CFS slot操作をproductionへ昇格してよいregistry登録済み証跡か検証する。
 *
 * 【詳細説明】
 * - {@link validateK2CfsSlotControlCertificationEvidence} でshape/scopeを検証したうえで、
 *   module-owned immutable registryへ登録済みの証跡だけをproduction commandへ使う。
 * - connection targetやUI設定が同じshapeのobjectを持っていても、registry未登録なら拒否する。
 *
 * @function validateRegisteredK2CfsSlotControlCertificationEvidence
 * @param {*} evidence - 検証対象のcertification evidence
 * @param {string} commandKind - production昇格したいcommand kind
 * @param {object=} scope - 現在target/runtimeから得たscope
 * @returns {{ok: boolean, errors: string[]}} registry境界を含む検証結果
 * @example
 * const result = validateRegisteredK2CfsSlotControlCertificationEvidence(evidence, "cfs-load", scope);
 */
export function validateRegisteredK2CfsSlotControlCertificationEvidence(evidence, commandKind, scope = {}) {
  const validation = validateK2CfsSlotControlCertificationEvidence(evidence, commandKind, scope);
  const errors = [...validation.errors];
  if (validation.ok && !isRegisteredCfsSlotControlCertificationEvidence(evidence, commandKind)) {
    errors.push("certification-evidence-not-registered");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * 指定command kindが実機certification済みとして明示されているか判定する。
 *
 * 【詳細説明】
 * - 既定では常にfalseに倒し、単独CFS操作が暗黙にproductionへ昇格しないようにする。
 * - optionは配列/Set/object mapを受けるが、どれも呼び出し側が明示したallow-listとしてのみ扱う。
 *
 * @private
 * @param {string} commandKind - 正規化済みcommand kind
 * @param {object=} options - transport plan生成option
 * @returns {boolean} 実機certification済みとして扱う場合true
 */
function isCertifiedCfsSlotControlCommand(commandKind, options = {}) {
  const registry = options?.certifiedCfsSlotControlCommands;
  if (Array.isArray(registry)) {
    return registry.includes(commandKind);
  }
  if (registry instanceof Set) {
    return registry.has(commandKind);
  }
  if (registry && typeof registry === "object") {
    return registry[commandKind] === true;
  }
  return false;
}

/**
 * certification evidenceがmodule-owned registryに登録済みか判定する。
 *
 * 【詳細説明】
 * - caller supplied evidenceは現在scopeとの整合性検証だけでなく、コード内registryとの完全一致を要求する。
 * - command kindはregistry entryの`commandKinds`/`commandKind`にも含まれている必要がある。
 *
 * @private
 * @function isRegisteredCfsSlotControlCertificationEvidence
 * @param {object|null|undefined} evidence - caller supplied certification evidence
 * @param {string} commandKind - production昇格したいcommand kind
 * @returns {boolean} registryに同一証跡がある場合true
 */
function isRegisteredCfsSlotControlCertificationEvidence(evidence, commandKind) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return false;
  }
  const candidate = stableJsonStringify(evidence);
  return K2_CFS_SLOT_CONTROL_CERTIFICATION_REGISTRY.some((entry) => {
    if (!normalizeCertificationEvidenceCommandKinds(entry).has(commandKind)) {
      return false;
    }
    return stableJsonStringify(entry) === candidate;
  });
}

/**
 * frame送信hookの戻り値からstatus文字列を取り出す。
 *
 * 【詳細説明】
 * - connection layerやCLIの戻り値shapeが少し違っても、status/result/codeを同じ判定へ寄せる。
 *
 * @private
 * @param {*} response - frame送信hookの戻り値
 * @returns {string} 正規化済みstatus文字列
 */
function normalizeFrameResponseStatus(response) {
  return String(response?.status || response?.result || response?.code || "").trim().toLowerCase();
}

/**
 * frame送信hookの戻り値が次frameへ進める内容か判定する。
 *
 * 【詳細説明】
 * - `ok:false`、`error`、明示失敗statusは拒否する。
 * - statusが無い戻り値は、送信完了証跡にならないため拒否する。
 *
 * @private
 * @param {*} response - frame送信hookの戻り値
 * @returns {{ok: boolean, status: string, reason: string|null}} 判定結果
 */
function validateFrameResponse(response) {
  const status = normalizeFrameResponseStatus(response);
  if (!response || typeof response !== "object") {
    return { ok: false, status, reason: "missing-frame-response" };
  }
  if (response.ok === false || response.error) {
    return { ok: false, status, reason: "frame-response-error" };
  }
  if (K2_CFS_FRAME_REJECTED_STATUSES.has(status)) {
    return { ok: false, status, reason: "frame-response-rejected-status" };
  }
  if (K2_CFS_FRAME_ACCEPTED_STATUSES.has(status) || response.ok === true) {
    return { ok: true, status: status || "ok", reason: null };
  }
  return { ok: false, status, reason: "unknown-frame-response-status" };
}

/**
 * transport全体のstatusをframe response群から決める。
 *
 * 【詳細説明】
 * - `sent` / `submitted` だけなら、protocol ackではなく local submitted として返す。
 * - protocol受理statusだけで揃った場合だけ `acknowledged` へ昇格する。
 *
 * @private
 * @param {object[]} responses - 正規化前のframe response一覧
 * @returns {string} transport response status
 */
function deriveTransportStatus(responses) {
  const statuses = responses.map((response) => normalizeFrameResponseStatus(response));
  const hasOnlyProtocolAck = statuses.every((status) => ["accepted", "acknowledged", "ok", "success"].includes(status));
  return hasOnlyProtocolAck ? "acknowledged" : "submitted";
}

/**
 * response群からprotocol response ID候補を取り出す。
 *
 * 【詳細説明】
 * - 合成IDは作らず、transport/protocolが実際に返したIDだけをcorrelation候補にする。
 *
 * @private
 * @param {object[]} responses - frame response一覧
 * @returns {string[]} protocol response ID一覧
 */
function extractProtocolFrameIds(responses) {
  return responses
    .map((response) => toNonEmptyString(
      response?.protocolCommandId ||
      response?.protocolResponseId ||
      response?.responseId ||
      response?.requestId
    ))
    .filter(Boolean);
}

/**
 * assignmentから材料protocol値と由来を取り出す。
 *
 * 【詳細説明】
 * - type/colorをどの入力から採用したかをtransport plan detailsへ残し、live certification時に
 *   送信直前のCFS slot観測と突き合わせられるようにする。
 *
 * @private
 * @param {{path: string, value: *}[]} candidates - 候補値一覧
 * @returns {{value: string|null, provenance: string|null}} 正規化値と由来
 */
function pickMaterialProtocolValue(candidates) {
  for (const candidate of candidates) {
    const value = toNonEmptyString(candidate.value);
    if (value) {
      return {
        value,
        provenance: candidate.path,
      };
    }
  }
  return {
    value: null,
    provenance: null,
  };
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
  return createTrustedTransportPlan({
    schemaVersion: K2_CFS_COMMAND_TRANSPORT_PLAN_SCHEMA_VERSION,
    ok: false,
    reason,
    transportKind: "ws9999",
    profile: null,
    frames: [],
    details: {
      ...details,
    },
  });
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
  const typeEvidence = pickMaterialProtocolValue([
    { path: "assignment.protocol.materialType", value: assignment?.protocol?.materialType },
    { path: "assignment.protocol.type", value: assignment?.protocol?.type },
    { path: "assignment.material.type", value: assignment?.material?.type },
  ]);
  const colorEvidence = pickMaterialProtocolValue([
    { path: "assignment.protocol.color", value: getMaterialProtocolColor(assignment?.protocol?.color) },
    { path: "assignment.material.color", value: getMaterialProtocolColor(assignment?.material?.color) },
  ]);
  const type = typeEvidence.value;
  const color = colorEvidence.value;
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
    evidence: {
      protocolToolAlias: alias,
      sourceId,
      type,
      typeProvenance: typeEvidence.provenance,
      color,
      colorProvenance: colorEvidence.provenance,
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
  const assignmentEvidence = [];
  for (const assignment of assignments) {
    const result = createColorMatchEntry(assignment);
    if (!result.ok) {
      return createRejectedTransportPlan(result.reason, {
        sourceId: result.sourceId,
      });
    }
    colorMatchList.push(result.entry);
    assignmentEvidence.push(result.evidence);
  }
  return createTrustedTransportPlan({
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
      materialSupply: "cfs",
      assignmentCount: colorMatchList.length,
      assignmentEvidence,
    },
  });
}

/**
 * K2/CFS slot操作候補用のcertification-only transport frame列を生成する。
 *
 * 【詳細説明】
 * - このplanはGate 19のdry-run/live certification専用で、production UI操作には使わない。
 * - `feedInOrOut` は公開CrealityPrint device UI bundleから得た候補であり、F012実機captureで意味を確定するまで
 *   `certificationOnly:true` と `requiresLiveConfirmation:true` を必ず付ける。
 * - source locationはNormalizedStateのsourceIdだけから決め、caller supplied boxId/materialIdを採用しない。
 *
 * @private
 * @param {object} request - Printer Core command request
 * @param {string} commandKind - 正規化済みcommand kind
 * @returns {object} certification-only transport plan
 */
function createK2CfsSlotControlFeedInOrOutPlan(request, commandKind, options = {}) {
  const definition = CFS_SLOT_CONTROL_CANDIDATE_DEFINITIONS[commandKind];
  if (!definition) {
    return createRejectedTransportPlan("unsupported-cfs-slot-control-candidate", { commandKind });
  }
  const payload = request?.payload && typeof request.payload === "object" ? request.payload : {};
  const sourceId = toNonEmptyString(payload.sourceId || payload.materialSourceId || payload.source?.sourceId);
  const location = parseMaterialSourceLocation(sourceId);
  if (location.kind !== "cfs-slot") {
    return createRejectedTransportPlan("invalid-cfs-control-source-id", {
      commandKind,
      sourceId,
      sourceKind: location.kind,
    });
  }
  return createTrustedTransportPlan({
    schemaVersion: K2_CFS_COMMAND_TRANSPORT_PLAN_SCHEMA_VERSION,
    ok: true,
    reason: null,
    transportKind: "ws9999",
    profile: options.production === true
      ? K2_CFS_SLOT_CONTROL_PRODUCTION_TRANSPORT_PROFILE
      : K2_CFS_SLOT_CONTROL_CERTIFICATION_TRANSPORT_PROFILE,
    certificationOnly: options.production === true ? false : true,
    requiresLiveConfirmation: options.production === true ? false : true,
    frames: [
      {
        method: "set",
        params: {
          feedInOrOut: {
            boxId: location.boxId,
            materialId: location.materialId,
            isFeed: definition.isFeed,
          },
        },
      },
    ],
    details: {
      commandKind,
      sourceId,
      sourceKind: location.kind,
      boxId: location.boxId,
      materialId: location.materialId,
      candidateOperation: definition.candidateOperation,
      expectedObservation: definition.expectedObservation,
      semanticStatus: options.production === true ? "certified" : definition.semanticStatus,
      liveCertificationAllowed: definition.liveCertificationAllowed,
      safetyBoundary: options.production === true ? "production-certified" : "certification-only",
      productionEnabled: options.production === true,
      certificationEvidence: options.production === true
        ? cloneJsonValue(options.certificationEvidence || null)
        : undefined,
    },
  });
}

/**
 * K2/CFS slot操作候補用のcertification-only transport frame列を生成する。
 *
 * 【詳細説明】
 * - このplanはGate 19のdry-run/live certification専用で、production UI操作には使わない。
 * - `feedInOrOut` は公開CrealityPrint device UI bundleから得た候補であり、F012実機captureで意味を確定するまで
 *   `certificationOnly:true` と `requiresLiveConfirmation:true` を必ず付ける。
 * - source locationはNormalizedStateのsourceIdだけから決め、caller supplied boxId/materialIdを採用しない。
 *
 * @private
 * @param {object} request - Printer Core command request
 * @param {string} commandKind - 正規化済みcommand kind
 * @returns {object} certification-only transport plan
 */
function createK2CfsSlotControlCertificationPlan(request, commandKind) {
  return createK2CfsSlotControlFeedInOrOutPlan(request, commandKind, {
    production: false,
  });
}

/**
 * 実機certification済みCFS slot操作用のproduction transport frame列を生成する。
 *
 * 【詳細説明】
 * - command kindごとのallow-listを通過した場合だけ使う。
 * - 送信直前のsession/capability/topology確認はdispatcher層が担当し、この関数はWS9999 frame shapeだけを固定する。
 *
 * @private
 * @param {object} request - Printer Core command request
 * @param {string} commandKind - 正規化済みcommand kind
 * @param {object=} options - transport plan生成option
 * @returns {object} production transport plan
 */
function createK2CfsSlotControlProductionPlan(request, commandKind, options = {}) {
  const evidenceValidation = validateRegisteredK2CfsSlotControlCertificationEvidence(
    options.certificationEvidence,
    commandKind,
    options.certificationScope || {}
  );
  if (!evidenceValidation.ok) {
    return createRejectedTransportPlan("invalid-cfs-slot-certification-evidence", {
      commandKind,
      errors: evidenceValidation.errors,
    });
  }
  return createK2CfsSlotControlFeedInOrOutPlan(request, commandKind, {
    production: true,
    certificationEvidence: options.certificationEvidence || null,
  });
}

/**
 * Printer Core command request から K2/CFS transport plan を生成する。
 *
 * 【詳細説明】
 * - `print-start` 以外のCFS操作は、LAN command keyが未certifiedなので拒否する。
 * - `print-start` でもCFS明示割当が足りない場合は拒否する。
 * - Gate 19のcertificationでは、`allowUncertifiedCfsSlotCommandCandidates:true` を明示した場合だけ
 *   `feedInOrOut` 候補planを返す。通常callerはこのoptionを渡さない。
 *
 * @function createK2CfsCommandTransportPlan
 * @param {object|null|undefined} request - Printer Core command request
 * @param {object=} options - transport plan生成option
 * @param {boolean=} options.allowUncertifiedCfsSlotCommandCandidates - 未certified slot操作候補のdry-run生成可否
 * @param {Array<string>|Set<string>|Object<string,boolean>=} options.certifiedCfsSlotControlCommands - 実機certification済みslot操作allow-list
 * @param {object=} options.certificationEvidence - production昇格の実機証跡metadata
 * @returns {object} K2/CFS transport plan
 * @example
 * const plan = createK2CfsCommandTransportPlan(request);
 */
export function createK2CfsCommandTransportPlan(request, options = {}) {
  const commandKind = toNonEmptyString(request?.commandKind);
  if (!commandKind) {
    return createRejectedTransportPlan("missing-command-kind");
  }
  if (UNCERTIFIED_CFS_SLOT_COMMAND_KINDS.has(commandKind)) {
    if (isCertifiedCfsSlotControlCommand(commandKind, options)) {
      return createK2CfsSlotControlProductionPlan(request, commandKind, options);
    }
    if (options?.allowUncertifiedCfsSlotCommandCandidates === true) {
      return createK2CfsSlotControlCertificationPlan(request, commandKind);
    }
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
 * @param {object=} options - 送信option
 * @param {boolean=} options.allowCertificationOnly - certification-only planの送信可否
 * @param {boolean=} options.allowExperimentalSlotSemantics - select/feed/retractなどlive意味未確定candidateの送信可否
 * @returns {Promise<object>} transport response summary
 * @throws {Error} plan不正またはsend hook不正の場合
 * @example
 * await sendK2CfsCommandTransportPlan(plan, (frame) => sendCommand(frame.method, frame.params, host));
 */
export async function sendK2CfsCommandTransportPlan(plan, sendFrame, options = {}) {
  if (!TRUSTED_K2_CFS_TRANSPORT_PLANS.has(plan)) {
    throw new Error("K2 CFS command transport plan must be created by createK2CfsCommandTransportPlan.");
  }
  if (!plan?.ok) {
    throw new Error(`K2 CFS command transport plan rejected: ${plan?.reason || "unknown"}`);
  }
  if (plan.certificationOnly === true && options?.allowCertificationOnly !== true) {
    throw new Error("K2 CFS certification-only transport plan requires allowCertificationOnly.");
  }
  if (plan.certificationOnly === true &&
      plan.details?.liveCertificationAllowed === false &&
      options?.allowExperimentalSlotSemantics !== true) {
    throw new Error("K2 CFS experimental slot semantics require allowExperimentalSlotSemantics.");
  }
  if (typeof sendFrame !== "function") {
    throw new TypeError("K2 CFS command transport requires a sendFrame hook.");
  }
  const responses = [];
  for (let index = 0; index < plan.frames.length; index += 1) {
    const frame = plan.frames[index];
    // colorMatchとmultiColorPrintの順序が意味を持つため、並列送信せず必ず逐次awaitする。
    const response = await sendFrame(frame, {
      index,
      profile: plan.profile,
      frameCount: plan.frames.length,
    });
    const validation = validateFrameResponse(response);
    if (!validation.ok) {
      const error = new Error(`K2 CFS command frame ${index + 1} failed: ${validation.reason}`);
      error.reason = validation.reason;
      error.frameIndex = index;
      error.frameStatus = validation.status;
      error.frameResponse = response || null;
      throw error;
    }
    responses.push(response);
  }
  const protocolFrameIds = extractProtocolFrameIds(responses);
  const uniqueProtocolFrameIds = [...new Set(protocolFrameIds)];
  return {
    status: deriveTransportStatus(responses),
    protocolCommandId: uniqueProtocolFrameIds.length === 1 ? uniqueProtocolFrameIds[0] : null,
    protocolFrameIds,
    correlationEvidence: uniqueProtocolFrameIds.length > 0
      ? {
          kind: "protocol-response",
          protocolFrameIds,
          complete: protocolFrameIds.length === plan.frames.length,
        }
      : {
          kind: "none",
          reason: "no-protocol-response-id",
        },
    profile: plan.profile,
    sentFrameCount: responses.length,
    responses,
  };
}
