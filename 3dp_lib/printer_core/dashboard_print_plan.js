/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 Printer Core v3 PrintPlan モジュール
 * @file dashboard_print_plan.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_print_plan
 *
 * 【機能内容サマリ】
 * - 単色印刷でも明示 PrintPlan を生成する
 * - CFS/マルチカラー印刷の tool assignment を command 前に固定する
 * - G-code logical toolId と Creality protocol alias を分離する
 * - G-code asset と material source の対応を command 前に固定する
 * - PrintPlan から contract-only print-start command request を生成する
 *
 * 【公開関数一覧】
 * - {@link createSingleColorPrintPlan}：単色 PrintPlan を生成
 * - {@link createMulticolorCfsPrintPlan}：CFS/マルチカラー PrintPlan を生成
 * - {@link validatePrintPlan}：PrintPlan の整合性を検査
 * - {@link createPrintStartCommandRequestFromPlan}：PrintPlan から print-start command request を生成
 *
 * @version 1.390.1350 (PR #432)
 * @since   1.390.1343 (PR #432)
 * @lastModified 2026-08-09 09:25:00
 * -----------------------------------------------------------
 * @todo
 * - 実送信 protocol 生成へ拡張する
 */

"use strict";

import { createPrinterCommandRequest } from "./dashboard_command_authority.js";
import { createPrinterCoreV3DeterministicId } from "./dashboard_data_schema_v3.js";

/**
 * PrintPlan schema version。
 *
 * 【詳細説明】
 * - Data Schema v3 の `printPlans` store へ将来保存する logical schema version。
 *
 * @constant {number}
 */
export const PRINT_PLAN_SCHEMA_VERSION = 1;

/**
 * G-code analysis attestation 用の module-private secret。
 *
 * 【詳細説明】
 * - caller が `analyzed:true` を手書きしても authority evidence にならないようにする。
 * - 現Gateでは実 analyzer registry の代替となる fail-closed placeholder として使う。
 *
 * @constant {string}
 */
const GCODE_ANALYSIS_ATTESTATION_SECRET = `printer-core-gcode-analysis:${Date.now()}:${Math.random()}`;

/**
 * upload receipt attestation 用の module-private secret。
 *
 * 【詳細説明】
 * - caller supplied receipt は path/hash/device が一致しても `trusted:false` のまま扱う。
 * - 将来のupload transport/providerだけが、このsecret相当の発行境界を所有する。
 *
 * @constant {string}
 */
const UPLOAD_RECEIPT_ATTESTATION_SECRET = `printer-core-upload-receipt:${Date.now()}:${Math.random()}`;

/**
 * JSON 互換値を deep clone する。
 *
 * 【詳細説明】
 * - PrintPlan は command/result と同じく監査可能な plain data として扱う。
 *
 * @private
 * @param {*} value - clone 対象
 * @returns {*} clone 済み値
 */
function cloneJsonValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * 必須文字列を正規化する。
 *
 * 【詳細説明】
 * - 空文字の asset/source/tool を PrintPlan に入れると command authority が推測へ逃げるため拒否する。
 *
 * @private
 * @param {*} value - 文字列候補
 * @param {string} name - エラー表示用の名前
 * @returns {string} 正規化済み文字列
 * @throws {TypeError} 空文字の場合
 */
function requireNonEmptyString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new TypeError(`PrintPlan requires a non-empty ${name}.`);
  }
  return text;
}

/**
 * logical tool ID を正規化する。
 *
 * 【詳細説明】
 * - G-code 内の tool は数値 ID として扱い、Creality protocol の `T1A` などとは分離する。
 *
 * @private
 * @param {*} value - tool ID 候補
 * @param {number} fallback - fallback tool ID
 * @returns {number} 正規化済み tool ID
 * @throws {TypeError} 不正な tool ID の場合
 */
function normalizeToolId(value, fallback = 0) {
  const raw = value === undefined || value === null ? fallback : value;
  if (typeof raw === "boolean" || Array.isArray(raw)) {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  if (typeof raw === "string" && raw.trim() === "") {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (typeof text === "string" && !/^(0|[1-9]\d*)$/u.test(text)) {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  const toolId = typeof text === "number" ? text : Number(text);
  if (!Number.isInteger(toolId) || toolId < 0) {
    throw new TypeError("PrintPlan requires a non-negative integer toolId.");
  }
  return toolId;
}

/**
 * 文字列を UTF-8 byte 配列へ変換する。
 *
 * 【詳細説明】
 * - ブラウザ/Nodeの両方で同期的に SHA-256 を計算するための小さな互換層。
 *
 * @private
 * @param {string} value - 変換対象文字列
 * @returns {number[]} UTF-8 byte 配列
 */
function encodeUtf8Bytes(value) {
  if (typeof TextEncoder !== "undefined") {
    return Array.from(new TextEncoder().encode(value));
  }
  return Array.from(unescape(encodeURIComponent(value))).map((char) => char.charCodeAt(0));
}

/**
 * SHA-256 hex digest を同期的に計算する。
 *
 * 【詳細説明】
 * - G-code content と analysis result の binding に使う。
 * - WebCrypto は async のため、同期 factory で使える最小実装をここに閉じ込める。
 *
 * @private
 * @param {string} value - digest 対象
 * @returns {string} 64桁 hex digest
 */
function createSha256Hex(value) {
  const bytes = encodeUtf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) {
    bytes.push(0);
  }
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) {
    bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (value32, bits) => (value32 >>> bits) | (value32 << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + index * 4;
      w[index] = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = (rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10)) >>> 0;
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + s1 + ch + k[index] + w[index]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((value32, index) => {
      h[index] = (h[index] + value32) >>> 0;
    });
  }
  return h.map((value32) => value32.toString(16).padStart(8, "0")).join("");
}

/**
 * G-code content から logical tool ID 配列を抽出する。
 *
 * 【詳細説明】
 * - `T0` / `T1` のような tool change command を順序保持で抽出する。
 * - tool command が無い場合は single logical tool `0` として扱う。
 *
 * @private
 * @param {string} content - G-code content
 * @returns {number[]} logical tool ID 配列
 */
function extractLogicalToolsFromGcodeContent(content) {
  const logicalTools = [];
  const seen = new Set();
  const pattern = /^\s*T(\d+)\b/gmu;
  let match = pattern.exec(content);
  while (match) {
    const toolId = normalizeToolId(match[1]);
    if (!seen.has(toolId)) {
      seen.add(toolId);
      logicalTools.push(toolId);
    }
    match = pattern.exec(content);
  }
  return logicalTools.length > 0 ? logicalTools : [0];
}

/**
 * G-code analysis attestation signature を生成する。
 *
 * 【詳細説明】
 * - signature は module-private secret を含むため、caller が plain object を手書きしても一致しない。
 * - Data Schema v3 では永続可能な analyzer registry signature へ置き換える想定。
 *
 * @private
 * @param {object} analysis - 正規化済み analysis
 * @returns {string} attestation signature
 */
function createGcodeAnalysisSignature(analysis) {
  return createPrinterCoreV3DeterministicId("gcode-analysis-attestation", [
    GCODE_ANALYSIS_ATTESTATION_SECRET,
    analysis.analysisId,
    analysis.fileHash,
    analysis.analyzerVersion,
    analysis.logicalTools.join(","),
  ]);
}

/**
 * upload receipt signature を生成する。
 *
 * 【詳細説明】
 * - 現Gateでは public factory からこの署名を発行しない。
 * - upload authority 接続時に、実upload結果から発行されたreceiptだけをtrusted化するためのplaceholder。
 *
 * @private
 * @param {object} receipt - upload receipt
 * @returns {string} signature
 */
function createUploadReceiptSignature(receipt) {
  return createPrinterCoreV3DeterministicId("upload-receipt", [
    UPLOAD_RECEIPT_ATTESTATION_SECRET,
    receipt.receiptId,
    receipt.deviceId,
    receipt.remotePath,
    receipt.fileHash,
    receipt.sessionId || "",
    receipt.uploadGeneration || "",
  ]);
}

/**
 * analysis payload から logical tool ID 候補を取り出す。
 *
 * 【詳細説明】
 * - analyzer の実装差で `logicalTools` / `tools` のどちらを返しても同じ意味として読む。
 * - `toolCount` だけから `0..N-1` を生成する fallback は authority PrintPlan では行わない。
 *
 * @private
 * @param {object} analysis - G-code analysis 候補
 * @returns {Array<*>|null} logical tool 候補配列
 */
function readAnalysisLogicalToolCandidates(analysis) {
  if (Array.isArray(analysis?.logicalTools)) {
    return analysis.logicalTools;
  }
  if (Array.isArray(analysis?.tools)) {
    return analysis.tools;
  }
  return null;
}

/**
 * G-code content から analysis attestation を生成する。
 *
 * 【詳細説明】
 * - caller claims に署名せず、content hash と logical tools をこの関数内で導出する。
 * - caller が同じshapeを手で組み立てても、module-private signature が一致しないため PrintPlan へ昇格しない。
 *
 * @function createGcodeAnalysisAttestation
 * @private
 * @param {object} options - analysis 生成オプション
 * @param {string} options.content - G-code content
 * @param {string=} options.analyzerVersion - analyzer version
 * @param {string=} options.analyzedAt - analysis 時刻
 * @returns {object} attested G-code analysis
 * @example
 * const analysis = createGcodeAnalysisAttestation({ content: "T0\nG1 X0" });
 */
function createGcodeAnalysisAttestation(options = {}) {
  if (Array.isArray(options.logicalTools) || Array.isArray(options.tools) || options.fileHash || options.sha256) {
    throw new TypeError("G-code analysis attestation derives fileHash and logicalTools from content.");
  }
  const content = requireNonEmptyString(options.content, "asset.content");
  const fileHash = `sha256:${createSha256Hex(content)}`;
  const analyzerVersion = String(options.analyzerVersion || "printer-core-gcode-analyzer-v1").trim();
  const logicalTools = extractLogicalToolsFromGcodeContent(content);
  const analysisId = createPrinterCoreV3DeterministicId("gcode-analysis", [
    fileHash,
    analyzerVersion,
    logicalTools.join(","),
  ]);
  const analysis = {
    analyzed: true,
    analyzerVersion,
    fileHash,
    logicalTools,
    toolCount: logicalTools.length,
    analyzedAt: options.analyzedAt || null,
    provenance: {
      source: "printer-core-gcode-analyzer",
      analysisId,
      attestation: null,
    },
  };
  analysis.provenance.attestation = createGcodeAnalysisSignature({ ...analysis, analysisId });
  return analysis;
}

/**
 * G-code analysis evidence を正規化する。
 *
 * 【詳細説明】
 * - PrintPlan authority では、G-code analyzer が確定した logical tool list だけを採用する。
 * - `toolCount` や caller 指定 `asset.tools` だけでは、multicolor file を単色扱いできてしまうため拒否する。
 *
 * @private
 * @param {object} asset - G-code asset 候補
 * @returns {object} 正規化済み analysis evidence
 * @throws {TypeError} analysis evidence が不足している場合
 */
function normalizeGcodeAnalysis(asset) {
  const analysis = asset?.analysis;
  if (!analysis || typeof analysis !== "object" || analysis.analyzed !== true) {
    throw new TypeError("PrintPlan requires analyzed G-code logical tools.");
  }
  const analyzerVersion = requireNonEmptyString(
    analysis.analyzerVersion || analysis.source,
    "asset.analysis.analyzerVersion"
  );
  const fileHash = requireNonEmptyString(
    analysis.fileHash || analysis.sha256 || asset?.fileSha256 || asset?.fileMd5,
    "asset.analysis.fileHash"
  );
  if (!fileHash.startsWith("sha256:")) {
    throw new TypeError("PrintPlan G-code analysis requires a sha256 fileHash.");
  }
  const logicalToolCandidates = readAnalysisLogicalToolCandidates(analysis);
  if (!logicalToolCandidates || logicalToolCandidates.length === 0) {
    throw new TypeError("PrintPlan requires analyzed G-code logical tools.");
  }
  const logicalTools = logicalToolCandidates.map((tool, index) => normalizeToolId(tool?.toolId ?? tool, index));
  if (new Set(logicalTools).size !== logicalTools.length) {
    throw new TypeError("PrintPlan asset logical tools must be unique.");
  }
  const analysisId = createPrinterCoreV3DeterministicId("gcode-analysis", [
    fileHash,
    analyzerVersion,
    logicalTools.join(","),
  ]);
  const expectedAttestation = createGcodeAnalysisSignature({
    analysisId,
    fileHash,
    analyzerVersion,
    logicalTools,
  });
  if (
    analysis?.provenance?.source !== "printer-core-gcode-analyzer" ||
    analysis?.provenance?.analysisId !== analysisId ||
    analysis?.provenance?.attestation !== expectedAttestation
  ) {
    throw new TypeError("PrintPlan requires attested G-code analysis provenance.");
  }
  return {
    analyzed: true,
    analyzerVersion,
    fileHash,
    logicalTools,
    toolCount: logicalTools.length,
    analyzedAt: analysis.analyzedAt || null,
    provenance: {
      source: "printer-core-gcode-analyzer",
      analysisId,
      attestation: expectedAttestation,
    },
  };
}

/**
 * upload receipt を正規化する。
 *
 * 【詳細説明】
 * - 解析した `asset.content` と、実際に印刷する remote path の bytes を content hash で結び付ける。
 * - 既存 remote path を直接指定する authority 化は、printer 側 hash または再upload receipt が得られるまで拒否する。
 *
 * @private
 * @param {object} asset - G-code asset 候補
 * @param {string} path - remote print path
 * @param {string} fileHash - content hash
 * @param {string} deviceId - device ID
 * @returns {object} 正規化済み upload receipt
 */
function normalizeUploadReceipt(asset, path, fileHash, deviceId) {
  const receipt = asset?.uploadReceipt || asset?.uploadReceiptEvidence;
  if (!receipt || typeof receipt !== "object") {
    throw new TypeError("PrintPlan requires upload receipt for analyzed G-code bytes.");
  }
  const receiptId = requireNonEmptyString(receipt.receiptId || receipt.uploadReceiptId, "uploadReceipt.receiptId");
  const receiptPath = requireNonEmptyString(receipt.remotePath || receipt.path, "uploadReceipt.remotePath");
  const receiptHash = requireNonEmptyString(receipt.fileHash || receipt.contentHash || receipt.sha256, "uploadReceipt.fileHash");
  const receiptDeviceId = requireNonEmptyString(receipt.deviceId, "uploadReceipt.deviceId");
  const sessionId = String(receipt.sessionId || "").trim() || null;
  const uploadGeneration = String(receipt.uploadGeneration || "").trim() || null;
  if (receiptPath !== path) {
    throw new TypeError("PrintPlan upload receipt remotePath must match asset.path.");
  }
  if (receiptHash !== fileHash) {
    throw new TypeError("PrintPlan upload receipt fileHash must match analyzed content hash.");
  }
  if (receiptDeviceId !== deviceId) {
    throw new TypeError("PrintPlan upload receipt deviceId must match plan deviceId.");
  }
  const trustedReceipt = {
    receiptId,
    deviceId: receiptDeviceId,
    remotePath: receiptPath,
    fileHash: receiptHash,
    sessionId,
    uploadGeneration,
  };
  const expectedAttestation = createUploadReceiptSignature(trustedReceipt);
  const trusted = receipt.provenance?.source === "printer-core-upload-authority" &&
    receipt.provenance?.attestation === expectedAttestation;
  return {
    receiptId,
    uploadReceiptId: receiptId,
    deviceId: receiptDeviceId,
    remotePath: receiptPath,
    fileHash: receiptHash,
    sessionId,
    uploadGeneration,
    uploadedAt: receipt.uploadedAt || null,
    source: receipt.source || "printer-core-upload",
    trusted,
    provenance: {
      source: receipt.provenance?.source || "caller-declared",
      attestation: receipt.provenance?.attestation || null,
    },
  };
}

/**
 * G-code asset 情報を正規化する。
 *
 * 【詳細説明】
 * - path/name/fileName のうち少なくとも path が必要。assetId が無い場合は deterministic ID を生成する。
 *
 * @private
 * @param {object} asset - G-code asset 候補
 * @param {string} deviceId - device ID
 * @returns {object} 正規化済み asset
 */
function normalizeGcodeAsset(asset, deviceId) {
  const path = requireNonEmptyString(asset?.path || asset?.filePath || asset?.filename, "asset.path");
  const fileName = String(asset?.fileName || asset?.name || path.split(/[\\/]/u).pop() || path).trim();
  if (asset?.analysis !== undefined) {
    throw new TypeError("PrintPlan derives G-code analysis from asset.content.");
  }
  const content = requireNonEmptyString(asset?.content || asset?.gcodeContent, "asset.content");
  const analysis = normalizeGcodeAnalysis({
    analysis: createGcodeAnalysisAttestation({
      content,
      analyzerVersion: asset?.analyzerVersion || "printer-core-gcode-analyzer-v1",
    }),
  });
  const expectedAssetId = createPrinterCoreV3DeterministicId("gcode-asset", [path, fileName, analysis.fileHash]);
  if (asset?.assetId && asset.assetId !== expectedAssetId) {
    throw new TypeError("PrintPlan assetId must match analyzed content hash.");
  }
  const uploadReceipt = normalizeUploadReceipt(asset, path, analysis.fileHash, deviceId);
  return {
    assetId: expectedAssetId,
    path,
    fileName,
    fileMd5: asset?.fileMd5 || null,
    fileHash: analysis.fileHash,
    uploadReceiptId: uploadReceipt.receiptId,
    uploadReceipt,
    toolCount: analysis.toolCount,
    logicalTools: analysis.logicalTools,
    analysis,
  };
}

/**
 * マルチカラーCFS用 colorMatch policy を正規化する。
 *
 * 【詳細説明】
 * - caller が `requireObservedSelectedSource:false` を渡しても、authority前提条件を弱めない。
 * - 追加の source/protocol note は保持するが、安全に関わる2項目は固定する。
 *
 * @private
 * @param {object|null|undefined} policy - caller 指定 policy
 * @returns {object} 正規化済み policy
 */
function normalizeMulticolorColorMatchPolicy(policy) {
  const sourcePolicy = policy && typeof policy === "object" ? cloneJsonValue(policy) : {};
  return {
    ...sourcePolicy,
    mode: "explicit-tool-assignment",
    requireObservedSelectedSource: true,
  };
}

/**
 * tool assignment を生成する。
 *
 * 【詳細説明】
 * - materialSourceId を必須にし、外部リール/CFS slot/将来の spool mount を command 前に明示する。
 * - Creality 側の `colorMatch`/assignment を後で検証できるように、任意の protocol evidence も保持する。
 *
 * @private
 * @param {object} options - assignment 生成オプション
 * @param {number|string} options.toolId - G-code logical tool ID
 * @param {string=} options.protocolToolAlias - Creality protocol/source alias
 * @param {string} options.materialSourceId - material source ID
 * @param {string=} options.spoolId - material source に装着済みの spool ID
 * @param {number=} index - assignment index
 * @returns {object} tool assignment
 */
function createToolAssignment(options, index = 0) {
  const toolId = normalizeToolId(options.toolId, index);
  const protocolToolAlias = requireNonEmptyString(options.protocolToolAlias || options.toolAlias, "protocolToolAlias");
  const materialSourceId = requireNonEmptyString(options.materialSourceId, "materialSourceId");
  const spoolId = String(options.spoolId || "").trim() || null;
  return {
    assignmentId: createPrinterCoreV3DeterministicId("tool-assignment", [toolId, protocolToolAlias, materialSourceId]),
    toolId,
    protocolToolAlias,
    toolAlias: protocolToolAlias,
    materialSourceId,
    spoolId,
    confidence: options.confidence || "operator-confirmed",
    order: Number.isFinite(Number(options.order)) ? Number(options.order) : index,
    protocol: cloneJsonValue(options.protocol || {}),
  };
}

/**
 * material source ID の一覧を assignment から生成する。
 *
 * 【詳細説明】
 * - 複数 tool が同じ material source を指す可能性は残しつつ、PrintPlan 上の source 集合は重複を除く。
 *
 * @private
 * @param {object[]} assignments - tool assignment 配列
 * @returns {string[]} material source ID 配列
 */
function collectMaterialSourceIds(assignments) {
  return [...new Set(assignments.map((assignment) => assignment.materialSourceId))];
}

/**
 * 単色 PrintPlan を生成する。
 *
 * 【詳細説明】
 * - 1色印刷でも PrintPlan を通すことで、`opGcodeFile` 直投げと material source 未選択を避ける。
 * - CFS/外部リールのどちらでも materialSourceId を必須にし、後続 command が推測に依存しないようにする。
 *
 * @function createSingleColorPrintPlan
 * @param {object} options - PrintPlan 生成オプション
 * @param {string} options.deviceId - 物理 device ID
 * @param {object} options.asset - G-code asset
 * @param {string} options.materialSourceId - material source ID
 * @param {string=} options.toolAlias - G-code tool alias
 * @param {string=} options.createdAt - 作成時刻 ISO 文字列
 * @param {object=} options.preflight - preflight evidence
 * @returns {object} 単色 PrintPlan
 * @example
 * const plan = createSingleColorPrintPlan({ deviceId, asset, materialSourceId });
 */
export function createSingleColorPrintPlan(options = {}) {
  const deviceId = requireNonEmptyString(options.deviceId, "deviceId");
  const asset = normalizeGcodeAsset(options.asset || {}, deviceId);
  const assignment = createToolAssignment({
    toolId: options.toolId ?? 0,
    protocolToolAlias: options.protocolToolAlias || options.toolAlias,
    materialSourceId: options.materialSourceId,
    spoolId: options.spoolId,
    confidence: options.confidence,
  });
  const printPlanId = options.printPlanId || createPrinterCoreV3DeterministicId("print-plan", [
    deviceId,
    asset.assetId,
    assignment.assignmentId,
  ]);
  const plan = {
    schemaVersion: PRINT_PLAN_SCHEMA_VERSION,
    printPlanId,
    planKind: "single-color",
    deviceId,
    asset,
    toolAssignments: [assignment],
    materialSourceIds: collectMaterialSourceIds([assignment]),
    preflight: cloneJsonValue(options.preflight || {}),
    createdAt: options.createdAt || null,
    authority: {
      mode: "plan-only",
      canStartPrint: false,
      uploadReceiptTrusted: asset.uploadReceipt.trusted === true,
      requiresCommandAuthority: true,
      requiresExpectedStateConfirmation: true,
    },
  };
  const validation = validatePrintPlan(plan);
  if (!validation.ok) {
    throw new TypeError(`Invalid PrintPlan: ${validation.errors.join(",")}`);
  }
  return plan;
}

/**
 * CFS/マルチカラー PrintPlan を生成する。
 *
 * 【詳細説明】
 * - 4色 benchy のような multi tool G-code では、各 tool alias と CFS material source の対応を必須にする。
 * - `selected` なしの dry-run 的な印刷を防ぐため、assignment 未確定の tool を含む plan は作らない。
 * - Gate 16 時点では command authority へ渡す契約だけを作り、プリンタへの送信権限は付与しない。
 *
 * @function createMulticolorCfsPrintPlan
 * @param {object} options - PrintPlan 生成オプション
 * @param {string} options.deviceId - 物理 device ID
 * @param {object} options.asset - G-code asset
 * @param {object[]} options.toolAssignments - logical tool ID と material source ID の対応
 * @param {string=} options.createdAt - 作成時刻 ISO 文字列
 * @param {object=} options.preflight - preflight evidence
 * @param {object=} options.colorMatchPolicy - colorMatch/assignment 方針
 * @returns {object} CFS/マルチカラー PrintPlan
 * @example
 * const plan = createMulticolorCfsPrintPlan({ deviceId, asset, toolAssignments });
 */
export function createMulticolorCfsPrintPlan(options = {}) {
  const deviceId = requireNonEmptyString(options.deviceId, "deviceId");
  const inputAssignments = Array.isArray(options.toolAssignments) ? options.toolAssignments : [];
  if (inputAssignments.length < 2) {
    throw new TypeError("Multicolor CFS PrintPlan requires at least two toolAssignments.");
  }
  const assignments = inputAssignments.map((assignment, index) => createToolAssignment(assignment, index));
  const asset = normalizeGcodeAsset(options.asset || {}, deviceId);
  const materialSourceIds = collectMaterialSourceIds(assignments);
  const printPlanId = options.printPlanId || createPrinterCoreV3DeterministicId("print-plan", [
    deviceId,
    asset.assetId,
    ...assignments.map((assignment) => assignment.assignmentId),
  ]);
  const plan = {
    schemaVersion: PRINT_PLAN_SCHEMA_VERSION,
    printPlanId,
    planKind: "multicolor-cfs",
    deviceId,
    asset,
    toolAssignments: assignments,
    materialSourceIds,
    colorMatchPolicy: normalizeMulticolorColorMatchPolicy(options.colorMatchPolicy),
    preflight: cloneJsonValue(options.preflight || {}),
    createdAt: options.createdAt || null,
    authority: {
      mode: "plan-only",
      canStartPrint: false,
      uploadReceiptTrusted: asset.uploadReceipt.trusted === true,
      requiresCommandAuthority: true,
      requiresExpectedStateConfirmation: true,
    },
  };
  const validation = validatePrintPlan(plan);
  if (!validation.ok) {
    throw new TypeError(`Invalid PrintPlan: ${validation.errors.join(",")}`);
  }
  return plan;
}

/**
 * PrintPlan の整合性を検査する。
 *
 * 【詳細説明】
 * - 単色では assignment 1件、CFS/マルチカラーでは assignment 2件以上を要求する。
 * - 各 logical tool ID は重複を拒否し、material source ID は必ず command 前に明示させる。
 *
 * @function validatePrintPlan
 * @param {object|null|undefined} plan - PrintPlan
 * @returns {{ok: boolean, errors: string[]}} 検査結果
 * @example
 * const validation = validatePrintPlan(plan);
 */
export function validatePrintPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan-not-object"] };
  }
  for (const key of ["printPlanId", "planKind", "deviceId"]) {
    if (!String(plan[key] || "").trim()) {
      errors.push(`missing-${key}`);
    }
  }
  if (plan.schemaVersion !== PRINT_PLAN_SCHEMA_VERSION) {
    errors.push("unexpected-schema-version");
  }
  const supportedPlanKind = plan.planKind === "single-color" || plan.planKind === "multicolor-cfs";
  if (!supportedPlanKind) {
    errors.push("unsupported-plan-kind");
  }
  if (!plan.asset || typeof plan.asset !== "object" || !String(plan.asset.path || "").trim()) {
    errors.push("missing-asset-path");
  }
  if (!plan.asset?.uploadReceipt || typeof plan.asset.uploadReceipt !== "object") {
    errors.push("missing-upload-receipt");
  } else {
    if (plan.asset.uploadReceipt.remotePath !== plan.asset.path) {
      errors.push("upload-receipt-path-mismatch");
    }
    if (plan.asset.uploadReceipt.fileHash !== plan.asset.fileHash) {
      errors.push("upload-receipt-hash-mismatch");
    }
    if (plan.asset.uploadReceipt.deviceId !== plan.deviceId) {
      errors.push("upload-receipt-device-mismatch");
    }
  }
  const assignments = Array.isArray(plan.toolAssignments) ? plan.toolAssignments : [];
  if (plan.planKind === "single-color" && assignments.length !== 1) {
    errors.push("single-color-tool-assignment-count-invalid");
  }
  if (plan.planKind === "multicolor-cfs" && assignments.length < 2) {
    errors.push("multicolor-tool-assignment-count-invalid");
  }
  const toolIds = new Set();
  for (const assignment of assignments) {
    let toolId = null;
    try {
      if (assignment?.toolId === undefined || assignment?.toolId === null) {
        throw new TypeError("missing toolId");
      }
      toolId = normalizeToolId(assignment.toolId);
    } catch {
      toolId = null;
    }
    const protocolToolAlias = String(assignment?.protocolToolAlias || assignment?.toolAlias || "").trim();
    const materialSourceId = String(assignment?.materialSourceId || "").trim();
    if (toolId === null) {
      errors.push("missing-tool-id");
    } else if (toolIds.has(toolId)) {
      errors.push("duplicate-tool-id");
    } else {
      toolIds.add(toolId);
    }
    if (!protocolToolAlias) {
      errors.push("missing-protocol-tool-alias");
    }
    if (!materialSourceId) {
      errors.push("missing-material-source-id");
    }
  }
  if (plan.planKind === "multicolor-cfs") {
    if (!plan.colorMatchPolicy || typeof plan.colorMatchPolicy !== "object") {
      errors.push("missing-color-match-policy");
    } else {
      if (plan.colorMatchPolicy.mode !== "explicit-tool-assignment") {
        errors.push("unsafe-color-match-policy");
      }
      if (plan.colorMatchPolicy.requireObservedSelectedSource !== true) {
        errors.push("missing-observed-selected-source-policy");
      }
    }
  }
  let assetLogicalTools = [];
  try {
    const analysis = normalizeGcodeAnalysis(plan.asset || {});
    assetLogicalTools = analysis.logicalTools;
    if (Array.isArray(plan.asset?.logicalTools) && plan.asset.logicalTools.length > 0) {
      const topLevelLogicalTools = plan.asset.logicalTools.map((toolId) => normalizeToolId(toolId));
      if (
        topLevelLogicalTools.length !== assetLogicalTools.length ||
        topLevelLogicalTools.some((toolId, index) => toolId !== assetLogicalTools[index])
      ) {
        errors.push("asset-analysis-logical-tool-mismatch");
      }
    }
  } catch (error) {
    if (error instanceof TypeError && /must be unique/u.test(error.message)) {
      errors.push("duplicate-asset-logical-tool");
    } else if (error instanceof TypeError && /requires analyzed G-code logical tools/u.test(error.message)) {
      errors.push("missing-gcode-analysis");
    } else {
      errors.push("invalid-gcode-analysis");
    }
  }
  if (new Set(assetLogicalTools).size !== assetLogicalTools.length) {
    errors.push("duplicate-asset-logical-tool");
  }
  if (plan.asset?.toolCount && assignments.length > 0 && Number(plan.asset.toolCount) !== assignments.length) {
    errors.push("asset-tool-count-assignment-mismatch");
  }
  for (const toolId of assetLogicalTools) {
    if (!toolIds.has(toolId)) {
      errors.push("missing-gcode-tool-assignment");
    }
  }
  const expectedMaterialSourceIds = collectMaterialSourceIds(assignments);
  if (plan.planKind === "single-color" && (!Array.isArray(plan.materialSourceIds) || plan.materialSourceIds.length !== 1)) {
    errors.push("single-color-material-source-count-invalid");
  }
  if (!Array.isArray(plan.materialSourceIds) || plan.materialSourceIds.length !== expectedMaterialSourceIds.length) {
    errors.push("material-source-assignment-mismatch");
  } else if (expectedMaterialSourceIds.some((materialSourceId) => !plan.materialSourceIds.includes(materialSourceId))) {
    errors.push("material-source-assignment-mismatch");
  }
  if (plan.authority?.canStartPrint === true) {
    errors.push("plan-can-start-print");
  }
  if (plan.authority?.uploadReceiptTrusted === true && plan.asset?.uploadReceipt?.trusted !== true) {
    errors.push("untrusted-upload-receipt");
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * PrintPlan から print-start command request を生成する。
 *
 * 【詳細説明】
 * - request は `contract-only` であり、この関数もプリンタへ送信しない。
 * - command payload には PrintPlan ID、asset path、tool assignment を含め、送信 adapter が推測しなくてよい形にする。
 *
 * @function createPrintStartCommandRequestFromPlan
 * @param {object} plan - PrintPlan
 * @param {object} options - command request 生成オプション
 * @param {string} options.sessionId - active session ID
 * @param {string=} options.transportKind - 送信 transport 種別
 * @param {Function=} options.entropySource - command ID entropy source
 * @returns {object} print-start command request
 * @example
 * const request = createPrintStartCommandRequestFromPlan(plan, { sessionId });
 */
export function createPrintStartCommandRequestFromPlan(plan, options = {}) {
  const validation = validatePrintPlan(plan);
  if (!validation.ok) {
    throw new TypeError(`Invalid PrintPlan: ${validation.errors.join(",")}`);
  }
  return createPrinterCommandRequest({
    deviceId: plan.deviceId,
    sessionId: options.sessionId,
    commandKind: "print-start",
    transportKind: options.transportKind || "pending-adapter",
    payload: {
      printPlanId: plan.printPlanId,
      planKind: plan.planKind,
      asset: cloneJsonValue(plan.asset),
      toolAssignments: cloneJsonValue(plan.toolAssignments),
      materialSourceIds: cloneJsonValue(plan.materialSourceIds),
      colorMatchPolicy: cloneJsonValue(plan.colorMatchPolicy || null),
      multiColorPrint: plan.planKind === "multicolor-cfs",
    },
    expectedState: [
      {
        path: "print.stateLabel",
        operator: "oneOf",
        expected: ["printing", "checking"],
      },
    ],
    timeoutMs: options.timeoutMs,
    idempotencyKey: plan.printPlanId,
    entropySource: options.entropySource,
    createdAt: options.createdAt || null,
  });
}
