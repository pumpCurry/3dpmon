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
 * 指定ホストの稼働率データを計算する。
 * historyList と storedData から稼働時間・アイドル時間・稼働率を算出。
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

  // historyList から期間内の印刷を抽出
  const history = machine?.historyList || [];
  let printTimeMs = 0;
  let printCount = 0;
  let successCount = 0;
  let failCount = 0;
  let totalFilamentMm = 0;

  for (const entry of history) {
    const startMs = (entry.startTime || 0) * 1000;
    const endMs = (entry.endtime || 0) * 1000;
    if (startMs === 0) continue;
    // 期間内に重なる印刷のみ
    if (endMs > 0 && endMs < since) continue;
    if (startMs > now) continue;

    const effectiveStart = Math.max(startMs, since);
    const effectiveEnd = endMs > 0 ? Math.min(endMs, now) : now;
    const duration = effectiveEnd - effectiveStart;
    if (duration > 0) {
      printTimeMs += duration;
      printCount++;
      // ★ 成功判定: printfinish=1 を優先、なければ printProgress>=100 で判定
      const isSuccess = entry.printfinish === 1 || entry.printProgress >= 100;
      if (isSuccess) successCount++;
      else if (endMs > 0) failCount++;
    }

    // フィラメント消費: デバイス報告値 (usagematerial) を使用
    // ★ filamentInfo[].length は存在しないフィールドだったため修正
    const usedMm = Number(entry.usagematerial || 0);
    if (usedMm > 0) totalFilamentMm += usedMm;
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
 * 全ホストの historyList を日ごとに集約。
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

  // 全ホストの履歴を走査
  for (const [hostname, machine] of Object.entries(monitorData.machines)) {
    if (hostname === "_$_NO_MACHINE_$_") continue;
    const history = machine?.historyList || [];
    for (const entry of history) {
      const startSec = entry.startTime || 0;
      if (startSec === 0) continue;
      const dateKey = _localDateKey(new Date(startSec * 1000));
      const day = dayMap[dateKey];
      if (!day) continue;

      const durationSec = (entry.endtime || 0) > 0
        ? (entry.endtime - startSec)
        : 0;
      // ★ 成功判定: printfinish=1 を優先、なければ printProgress>=100 で判定
      const isSuccess = entry.printfinish === 1 || entry.printProgress >= 100;

      day.printCount++;
      if (isSuccess) {
        day.successCount++;
        // ★ 成功印刷の時間のみを生産時間として計上
        day.totalPrintTimeSec += durationSec;
      } else if ((entry.endtime || 0) > 0) {
        day.failCount++;
        day.failPrintTimeSec += durationSec;
      }

      // フィラメント消費: デバイス報告値 (usagematerial) を使用
      // ★ filamentInfo[].length は存在しないフィールドだったため修正
      const usedMm = Number(entry.usagematerial || 0);
      if (usedMm > 0) day.totalFilamentMm += usedMm;

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
  const history = machine?.historyList || [];

  // ファイル名別に集計（成功印刷のみで平均を算出）
  const fileMap = {};
  for (const entry of history) {
    const file = (entry.filename || "").split("/").pop();
    if (!file) continue;
    const durationSec = (entry.endtime || 0) > 0
      ? (entry.endtime - (entry.startTime || 0))
      : 0;
    if (durationSec <= 0) continue;
    // ★ 成功判定: printfinish=1 を優先、なければ printProgress>=100 で判定
    const isSuccess = entry.printfinish === 1 || entry.printProgress >= 100;

    if (!fileMap[file]) {
      fileMap[file] = {
        successTotalSec: 0, successCount: 0,
        totalCount: 0, estimatedSec: 0
      };
    }
    fileMap[file].totalCount++;
    if (isSuccess) {
      // ★ 成功印刷のみが平均値の算出対象（失敗/中断の途中値を排除）
      fileMap[file].successCount++;
      fileMap[file].successTotalSec += durationSec;
    }

    // GCode見積（usagetimeフィールド or メタデータキャッシュ）
    if (entry.usagetime > 0 && !fileMap[file].estimatedSec) {
      fileMap[file].estimatedSec = entry.usagetime;
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
