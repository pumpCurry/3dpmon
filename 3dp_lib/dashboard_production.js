/**
 * @fileoverview
 * @description 3Dプリンタ監視ツール 3dpmon 用 製造時間管理モジュール
 * @file dashboard_production.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module dashboard_production
 *
 * 【機能内容サマリ】
 * - per-host 稼働率計算
 * - 日次生産レポート生成
 * - 予定 vs 実績の比較
 * - 全ホスト横断サマリー
 *
 * 【公開関数一覧】
 * - {@link buildHostUtilization}：指定ホストの稼働率データ
 * - {@link buildDailyProductionReport}：日次生産レポート
 * - {@link buildEstimateVsActual}：予定vs実績比較リスト
 * - {@link buildFleetSummary}：全ホスト横断サマリー
 *
 * @version 1.390.800 (PR #367)
 * @since   1.390.800 (PR #367)
 * @lastModified 2026-03-24
 * -----------------------------------------------------------
 */

"use strict";

import { monitorData } from "./dashboard_data.js";

/**
 * 印刷状態コード
 * @enum {number}
 */
const PRINT_STATE = {
  IDLE: 0,
  PRINTING: 1,
  PAUSED: 2,
  COMPLETED: 3,
  ERROR: 4
};

/**
 * パース済み履歴エントリ（printStore.history）から統計用の正規化値を取り出す。
 *
 * printStore.history には parseRawHistoryEntry() の出力が入る:
 *   startTime    : ISO文字列
 *   startTimeSec : epoch秒（比較用）
 *   finishTime   : ISO文字列|null
 *   materialUsedMm : 使用フィラメント量(mm)
 *   printfinish  : 1=成功 / 0=未完了・失敗
 * （旧式の生データフィールド starttime/endtime/usagematerial ではない点に注意）
 * 古い永続データに startTimeSec/finishTimeSec が無い場合は ISO 文字列から補う。
 *
 * @param {Object} entry - printStore.history のエントリ
 * @returns {{startSec:number, finishSec:number, durationSec:number,
 *            materialMm:number, isSuccess:boolean, isFinished:boolean}}
 */
function _normalizeHistoryEntry(entry) {
  const startSec = Number(entry?.startTimeSec)
    || (entry?.startTime ? Math.floor(Date.parse(entry.startTime) / 1000) : 0)
    || 0;
  const finishSec = Number(entry?.finishTimeSec)
    || (entry?.finishTime ? Math.floor(Date.parse(entry.finishTime) / 1000) : 0)
    || 0;
  const durationSec = (finishSec > startSec) ? (finishSec - startSec) : 0;
  const materialMm = Number(entry?.materialUsedMm || 0);
  const isSuccess = entry?.printfinish === 1;
  // 履歴に積まれた時点で完了済み。finishTime があれば確実に終了とみなす
  const isFinished = finishSec > 0 || entry?.printfinish != null;
  return { startSec, finishSec, durationSec, materialMm, isSuccess, isFinished };
}

/**
 * スプール1本あたりの mm 単価（円/mm）を求める。
 * @param {Object} spool - フィラメントスプール
 * @returns {number} 円/mm（不明なら 0）
 */
function _spoolCostPerMm(spool) {
  if (!spool) return 0;
  if (spool.costPerMm > 0) return spool.costPerMm;
  if (spool.purchasePrice > 0 && spool.totalLengthMm > 0) {
    return spool.purchasePrice / spool.totalLengthMm;
  }
  return 0;
}

/**
 * 印刷ジョブのフィラメントコスト（円）を求める。
 * 履歴に materialCostYen があればそれを優先し、無ければ
 * 使用量(mm) × スプール単価(円/mm) で算出する（スプール未特定なら 0）。
 *
 * @param {Object} job - printStore.history のエントリ
 * @returns {number} コスト（円）
 */
function _jobCostYen(job) {
  if (job?.materialCostYen != null) return Number(job.materialCostYen) || 0;
  const mm = Number(job?.materialUsedMm || 0);
  if (mm <= 0 || !job?.filamentId) return 0;
  const spool = (monitorData.filamentSpools || []).find(s => s.id === job.filamentId);
  return mm * _spoolCostPerMm(spool);
}

/**
 * gcode メタキャッシュを読み込む（GCode 見積時間 timeSec の参照用）。
 *
 * printmanager がアップロード時に localStorage キー "3dpmon_gcode_meta_cache" へ
 * `${host}:${basename}` をキーに保存している辞書をそのまま読む。
 * printmanager を import するとテスト(node)環境で重い依存ツリーを巻き込むため、
 * ここでは localStorage を直接参照し、無い環境では空辞書を返す。
 *
 * @returns {Object<string, {timeSec?:number}>} メタ辞書（取得不可なら {}）
 */
function _loadGcodeMetaCache() {
  try {
    const raw = localStorage.getItem("3dpmon_gcode_meta_cache");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * 指定ホストの稼働率データを計算する。
 * printStore.history と storedData から稼働時間・アイドル時間・稼働率を算出。
 *
 * @param {string} hostname - ホスト名
 * @param {Object} [options] - オプション
 * @param {number} [options.periodMs=86400000] - 集計期間（ミリ秒、デフォルト24時間）
 * @param {number} [options.since] - 集計開始時刻（エポックミリ秒）
 * @returns {{
 *   hostname: string,
 *   displayName: string,
 *   periodMs: number,
 *   printTimeMs: number,
 *   idleTimeMs: number,
 *   utilizationPct: number,
 *   printCount: number,
 *   successCount: number,
 *   failCount: number,
 *   successRate: number,
 *   totalFilamentMm: number,
 *   isPrinting: boolean,
 *   currentJobProgress: number,
 *   currentJobFile: string
 * }}
 */
export function buildHostUtilization(hostname, options = {}) {
  const now = Date.now();
  const periodMs = options.periodMs || 86400000; // 24時間
  const since = options.since || (now - periodMs);
  const machine = monitorData.machines[hostname];
  const sd = machine?.storedData || {};

  // printStore.history（parseRawHistoryEntry 済み）から期間内の印刷を抽出
  const history = machine?.printStore?.history || [];
  let printTimeMs = 0;
  let printCount = 0;
  let successCount = 0;
  let failCount = 0;
  let totalFilamentMm = 0;

  for (const entry of history) {
    const { startSec, finishSec, materialMm, isSuccess } = _normalizeHistoryEntry(entry);
    if (startSec === 0) continue;
    const startMs = startSec * 1000;
    const endMs = finishSec * 1000;        // 終了時刻不明（印刷中等）は 0
    // 期間に重なる印刷のみ（ウィンドウより前に終了 / 未来開始は除外）
    if (endMs > 0 && endMs < since) continue;
    if (startMs > now) continue;

    const effectiveStart = Math.max(startMs, since);
    const effectiveEnd = endMs > 0 ? Math.min(endMs, now) : now;
    const duration = effectiveEnd - effectiveStart;
    if (duration > 0) {
      printTimeMs += duration;
      printCount++;
      if (isSuccess) successCount++;
      else if (endMs > 0) failCount++;
      // フィラメント消費は期間内に計上した印刷分のみ加算（期間スコープと整合）
      if (materialMm > 0) totalFilamentMm += materialMm;
    }
  }

  const idleTimeMs = Math.max(0, periodMs - printTimeMs);
  const utilizationPct = periodMs > 0 ? (printTimeMs / periodMs) * 100 : 0;
  const successRate = printCount > 0 ? successCount / printCount : 0;

  // 現在の印刷状態
  const isPrinting = !!(sd.printProgress?.rawValue > 0 && sd.printProgress?.rawValue < 100);
  const currentJobProgress = Number(sd.printProgress?.rawValue || 0);
  const currentJobFile = sd.printFileName?.rawValue || "";
  const displayName = sd.hostname?.rawValue || hostname;

  return {
    hostname,
    displayName,
    periodMs,
    printTimeMs,
    idleTimeMs,
    utilizationPct: Math.min(100, parseFloat(utilizationPct.toFixed(1))),
    printCount,
    successCount,
    failCount,
    successRate: parseFloat(successRate.toFixed(3)),
    totalFilamentMm,
    isPrinting,
    currentJobProgress,
    currentJobFile
  };
}

/**
 * 日次生産レポートを生成する。
 * 全ホストの printStore.history を日ごとに集約。
 *
 * @param {Object} [options] - オプション
 * @param {number} [options.days=7] - 過去何日分を集計するか
 * @returns {Array<{
 *   date: string,
 *   printCount: number,
 *   successCount: number,
 *   failCount: number,
 *   totalPrintTimeSec: number,
 *   totalFilamentMm: number,
 *   byHost: Object<string, {printCount:number, printTimeSec:number}>
 * }>}
 */
export function buildDailyProductionReport(options = {}) {
  const days = options.days || 7;
  const now = new Date();
  const dayMap = {};

  /**
   * ローカルタイムゾーンで YYYY-MM-DD を生成する。
   * toISOString() はUTC基準で日付境界がずれるため使わない。
   * @param {Date} d - 日付
   * @returns {string} "YYYY-MM-DD"
   */
  function _localDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // 過去N日分の空データを初期化
  for (let d = 0; d < days; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const key = _localDateKey(date);
    dayMap[key] = {
      date: key,
      printCount: 0,
      successCount: 0,
      failCount: 0,
      totalPrintTimeSec: 0,    // 成功印刷の合計時間
      failPrintTimeSec: 0,     // 失敗印刷の合計時間（参考値）
      totalFilamentMm: 0,
      byHost: {}
    };
  }

  // 全ホストの履歴を走査（printStore.history が権威）
  for (const [hostname, machine] of Object.entries(monitorData.machines)) {
    if (hostname === "_$_NO_MACHINE_$_") continue;
    const history = machine?.printStore?.history || [];
    for (const entry of history) {
      const { startSec, durationSec, materialMm, isSuccess, isFinished } = _normalizeHistoryEntry(entry);
      if (startSec === 0) continue;
      const dateKey = _localDateKey(new Date(startSec * 1000));
      const day = dayMap[dateKey];
      if (!day) continue;

      day.printCount++;
      if (isSuccess) {
        day.successCount++;
        // 成功印刷の時間のみを生産時間として計上
        day.totalPrintTimeSec += durationSec;
      } else if (isFinished) {
        day.failCount++;
        day.failPrintTimeSec += durationSec;
      }

      if (materialMm > 0) day.totalFilamentMm += materialMm;

      if (!day.byHost[hostname]) {
        day.byHost[hostname] = { printCount: 0, printTimeSec: 0 };
      }
      day.byHost[hostname].printCount++;
      // 成功印刷の時間のみ計上（失敗分は byHost には含めない）
      if (isSuccess) {
        day.byHost[hostname].printTimeSec += durationSec;
      }
    }
  }

  // 日付降順でソートして返す
  return Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 予定 vs 実績の比較リストを生成する。
 * ファイル別にGCode見積時間 vs 実測平均時間を比較。
 *
 * @param {string} hostname - ホスト名
 * @returns {Array<{
 *   filename: string,
 *   estimatedSec: number,
 *   actualAvgSec: number,
 *   diffPct: number,
 *   printCount: number
 * }>}
 */
export function buildEstimateVsActual(hostname) {
  const machine = monitorData.machines[hostname];
  const history = machine?.printStore?.history || [];
  // GCode 見積時間の参照元（localStorage の gcode メタキャッシュ）を1回だけ読む
  const metaCache = _loadGcodeMetaCache();

  // ファイル名別に集計（成功印刷のみで実測平均を算出）
  const fileMap = {};
  for (const entry of history) {
    const file = (entry.filename || entry.rawFilename || "").split("/").pop();
    if (!file) continue;
    const { durationSec, isSuccess } = _normalizeHistoryEntry(entry);

    if (!fileMap[file]) {
      fileMap[file] = {
        successTotalSec: 0, successCount: 0,
        totalCount: 0, estimatedSec: 0
      };
    }
    fileMap[file].totalCount++;
    if (isSuccess && durationSec > 0) {
      // 成功印刷のみが平均値の算出対象（失敗/中断の途中値を排除）
      fileMap[file].successCount++;
      fileMap[file].successTotalSec += durationSec;
    }

    // GCode見積時間: アップロード時に記録した gcode メタキャッシュ(timeSec)から取得
    if (!fileMap[file].estimatedSec) {
      const meta = metaCache[`${hostname}:${file}`] || metaCache[file];
      if (meta?.timeSec > 0) fileMap[file].estimatedSec = Number(meta.timeSec);
    }
  }

  const results = [];
  for (const [filename, data] of Object.entries(fileMap)) {
    if (data.totalCount === 0) continue;
    // 成功印刷がなければ平均は算出不能
    const actualAvgSec = data.successCount > 0
      ? data.successTotalSec / data.successCount : 0;
    const estimatedSec = data.estimatedSec || 0;
    const diffPct = (estimatedSec > 0 && actualAvgSec > 0)
      ? ((actualAvgSec - estimatedSec) / estimatedSec) * 100
      : 0;

    results.push({
      filename,
      estimatedSec,
      actualAvgSec: Math.round(actualAvgSec),
      diffPct: parseFloat(diffPct.toFixed(1)),
      printCount: data.totalCount,
      successCount: data.successCount
    });
  }

  // 印刷回数が多い順
  results.sort((a, b) => b.printCount - a.printCount);
  return results;
}

/**
 * 全ホスト横断サマリーを生成する。
 *
 * @param {Object} [options] - オプション
 * @param {number} [options.periodMs=86400000] - 集計期間
 * @returns {{
 *   totalHosts: number,
 *   activeHosts: number,
 *   printingHosts: number,
 *   fleetUtilizationPct: number,
 *   totalPrintCount: number,
 *   totalSuccessCount: number,
 *   totalFailCount: number,
 *   totalPrintTimeMs: number,
 *   totalFilamentMm: number,
 *   hosts: Array<Object>
 * }}
 */
export function buildFleetSummary(options = {}) {
  const hosts = [];
  let totalPrintTimeMs = 0;
  let totalPeriodMs = 0;
  let totalPrintCount = 0;
  let totalSuccessCount = 0;
  let totalFailCount = 0;
  let totalFilamentMm = 0;
  let printingHosts = 0;

  for (const hostname of Object.keys(monitorData.machines)) {
    if (hostname === "_$_NO_MACHINE_$_") continue;
    const util = buildHostUtilization(hostname, options);
    hosts.push(util);
    totalPrintTimeMs += util.printTimeMs;
    totalPeriodMs += util.periodMs;
    totalPrintCount += util.printCount;
    totalSuccessCount += util.successCount;
    totalFailCount += util.failCount;
    totalFilamentMm += util.totalFilamentMm;
    if (util.isPrinting) printingHosts++;
  }

  const activeHosts = hosts.filter(h =>
    h.printCount > 0 || h.isPrinting
  ).length;
  const fleetUtilizationPct = totalPeriodMs > 0
    ? (totalPrintTimeMs / totalPeriodMs) * 100
    : 0;

  return {
    totalHosts: hosts.length,
    activeHosts,
    printingHosts,
    fleetUtilizationPct: parseFloat(fleetUtilizationPct.toFixed(1)),
    totalPrintCount,
    totalSuccessCount,
    totalFailCount,
    totalPrintTimeMs,
    totalFilamentMm,
    hosts
  };
}

// ======================================================================
//  Phase 2: 高度な統計集計関数
// ======================================================================

/**
 * 印刷物単価レポートを生成する。
 * ファイル名ごとにコスト・成功率・平均時間を集計する。
 *
 * @param {string} [hostname] - ホスト名（省略時は全ホスト合算）
 * @returns {Array<{
 *   filename: string,
 *   printCount: number,
 *   successCount: number,
 *   failCount: number,
 *   successRate: number,
 *   avgTimeSec: number,
 *   avgMaterialMm: number,
 *   avgCostYen: number,
 *   totalCostYen: number,
 *   wastedCostYen: number,
 *   costPerSuccess: number
 * }>}
 */
export function buildJobCostReport(hostname) {
  const fileMap = {};

  const hostnames = hostname
    ? [hostname]
    : Object.keys(monitorData.machines).filter(h => h !== "_$_NO_MACHINE_$_");

  for (const host of hostnames) {
    const machine = monitorData.machines[host];
    const history = machine?.printStore?.history || [];

    for (const job of history) {
      const file = (job.filename || job.rawFilename || "").split("/").pop();
      if (!file) continue;

      if (!fileMap[file]) {
        fileMap[file] = {
          filename: file,
          printCount: 0, successCount: 0, failCount: 0,
          totalTimeSec: 0, totalMaterialMm: 0, totalCostYen: 0,
          successTimeSec: 0, successMaterialMm: 0, successCostYen: 0,
          wastedCostYen: 0
        };
      }
      const f = fileMap[file];
      f.printCount++;

      const isSuccess = job.printfinish === 1;
      const usedMm = Number(job.materialUsedMm || 0);
      const cost = _jobCostYen(job);
      const durationSec = job.finishTime && job.startTime
        ? (new Date(job.finishTime).getTime() - new Date(job.startTime).getTime()) / 1000
        : 0;

      f.totalMaterialMm += usedMm;
      f.totalCostYen += cost;

      if (isSuccess) {
        f.successCount++;
        f.successTimeSec += durationSec;
        f.successMaterialMm += usedMm;
        f.successCostYen += cost;
      } else if (job.printfinish === 0 || job.printfinish === null) {
        // 印刷中（未完了）はカウントしない
      } else {
        f.failCount++;
        f.wastedCostYen += cost;
      }
    }
  }

  return Object.values(fileMap).map(f => ({
    filename: f.filename,
    printCount: f.printCount,
    successCount: f.successCount,
    failCount: f.failCount,
    successRate: f.printCount > 0 ? parseFloat((f.successCount / f.printCount).toFixed(3)) : 0,
    avgTimeSec: f.successCount > 0 ? Math.round(f.successTimeSec / f.successCount) : 0,
    avgMaterialMm: f.successCount > 0 ? Math.round(f.successMaterialMm / f.successCount) : 0,
    avgCostYen: f.successCount > 0 ? Math.round(f.successCostYen / f.successCount * 100) / 100 : 0,
    totalCostYen: Math.round(f.totalCostYen * 100) / 100,
    wastedCostYen: Math.round(f.wastedCostYen * 100) / 100,
    // 1個あたり真のコスト = (成功コスト + 失敗コスト) / 成功数
    costPerSuccess: f.successCount > 0
      ? Math.round(f.totalCostYen / f.successCount * 100) / 100
      : 0
  })).sort((a, b) => b.printCount - a.printCount);
}

/**
 * 機器ランキングを生成する。
 * 稼働率は直近期間（既定24h）の活動度、印刷回数・成功率・消費量・コストは
 * 累計（全履歴）で集計し、累計成功数の多い順にランキングする。
 *
 * @param {Object} [options] - オプション
 * @param {number} [options.periodMs=86400000] - 集計期間
 * @returns {Array<{
 *   hostname: string,
 *   displayName: string,
 *   utilizationPct: number,
 *   successRate: number,
 *   totalPrintCount: number,
 *   totalMaterialMm: number,
 *   totalCostYen: number,
 *   costPerSuccessPrint: number,
 *   rank: number
 * }>}
 */
export function buildHostRanking(options = {}) {
  const results = [];

  for (const hostname of Object.keys(monitorData.machines)) {
    if (hostname === "_$_NO_MACHINE_$_") continue;
    // 稼働率（バー表示）は直近期間（既定24h）の活動指標として取得
    const util = buildHostUtilization(hostname, options);
    const machine = monitorData.machines[hostname];
    const history = machine?.printStore?.history || [];

    // 印刷回数・成功率・消費量・コストは累計（全履歴）で集計する。
    // 履歴エントリは全て完了済みジョブなので、開始時刻の有無に関わらず1件として数える。
    let printCount = 0;
    let successCount = 0;
    let totalMaterialMm = 0;
    let totalCostYen = 0;
    for (const job of history) {
      const { materialMm, isSuccess } = _normalizeHistoryEntry(job);
      printCount++;
      if (isSuccess) successCount++;
      if (materialMm > 0) totalMaterialMm += materialMm;
      totalCostYen += _jobCostYen(job);
    }
    const successRate = printCount > 0 ? successCount / printCount : 0;

    results.push({
      hostname,
      displayName: util.displayName,
      utilizationPct: util.utilizationPct,             // 直近24hの活動度（バー用）
      successRate: parseFloat(successRate.toFixed(3)), // 累計成功率
      totalPrintCount: printCount,                     // 累計印刷回数
      totalMaterialMm,                                 // 累計消費量(mm)
      totalCostYen: Math.round(totalCostYen * 100) / 100,
      costPerSuccessPrint: successCount > 0
        ? Math.round(totalCostYen / successCount * 100) / 100
        : 0
    });
  }

  // 総合スコア: 累計成功数（= 印刷回数 × 成功率）の多い機器を上位にする
  results.sort((a, b) => {
    const scoreA = a.totalPrintCount * a.successRate;
    const scoreB = b.totalPrintCount * b.successRate;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.totalPrintCount - a.totalPrintCount;
  });
  results.forEach((r, i) => { r.rank = i + 1; });

  return results;
}

/**
 * 素材別消費レポートを生成する。
 * プリセット（ブランド×素材×色）ごとの消費量・コスト・月別推移を集計する。
 *
 * @returns {Array<{
 *   key: string,
 *   brand: string,
 *   material: string,
 *   colorName: string,
 *   filamentColor: string,
 *   totalConsumedMm: number,
 *   totalCostYen: number,
 *   spoolCount: number,
 *   printCount: number,
 *   avgCostPerMm: number,
 *   monthlyTrend: Array<{month: string, consumedMm: number, costYen: number}>
 * }>}
 */
export function buildMaterialReport() {
  const materialMap = {};

  for (const spool of monitorData.filamentSpools) {
    if (spool.deleted || spool.isDeleted) continue;

    const key = `${spool.brand || "不明"}|${spool.material || "不明"}|${spool.colorName || "不明"}`;
    if (!materialMap[key]) {
      materialMap[key] = {
        key,
        brand: spool.brand || spool.manufacturerName || "不明",
        material: spool.material || spool.materialName || "不明",
        colorName: spool.colorName || "不明",
        filamentColor: spool.filamentColor || spool.color || "#888",
        totalConsumedMm: 0,
        totalCostYen: 0,
        spoolCount: 0,
        printCount: 0,
        monthlyBuckets: {}
      };
    }
    const m = materialMap[key];
    m.spoolCount++;

    const consumed = Math.max(0, (spool.totalLengthMm || 0) - (spool.remainingLengthMm || 0));
    const costPerMm = spool.costPerMm || (spool.purchasePrice && spool.totalLengthMm
      ? spool.purchasePrice / spool.totalLengthMm : 0);
    const cost = consumed * costPerMm;

    m.totalConsumedMm += consumed;
    m.totalCostYen += cost;
    m.printCount += spool.printCount || 0;

    // usedLengthLog から月別消費を集計
    if (Array.isArray(spool.usedLengthLog)) {
      for (const log of spool.usedLengthLog) {
        const jobIdNum = Number(log.jobId);
        if (!Number.isFinite(jobIdNum) || jobIdNum <= 0) continue;
        // jobId は epoch 秒
        const date = new Date(jobIdNum * 1000);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        if (!m.monthlyBuckets[monthKey]) {
          m.monthlyBuckets[monthKey] = { consumedMm: 0, costYen: 0 };
        }
        const used = Number(log.used) || 0;
        m.monthlyBuckets[monthKey].consumedMm += used;
        m.monthlyBuckets[monthKey].costYen += used * costPerMm;
      }
    }
  }

  return Object.values(materialMap).map(m => ({
    key: m.key,
    brand: m.brand,
    material: m.material,
    colorName: m.colorName,
    filamentColor: m.filamentColor,
    totalConsumedMm: Math.round(m.totalConsumedMm),
    totalCostYen: Math.round(m.totalCostYen * 100) / 100,
    spoolCount: m.spoolCount,
    printCount: m.printCount,
    avgCostPerMm: m.totalConsumedMm > 0
      ? Math.round(m.totalCostYen / m.totalConsumedMm * 10000) / 10000
      : 0,
    monthlyTrend: Object.entries(m.monthlyBuckets)
      .map(([month, data]) => ({
        month,
        consumedMm: Math.round(data.consumedMm),
        costYen: Math.round(data.costYen * 100) / 100
      }))
      .sort((a, b) => a.month.localeCompare(b.month))
  })).sort((a, b) => b.totalConsumedMm - a.totalConsumedMm);
}
