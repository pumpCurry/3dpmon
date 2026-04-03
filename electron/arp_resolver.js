/**
 * @fileoverview
 * @description ARP テーブルから MAC アドレスを取得するクロスプラットフォームモジュール
 * @file electron/arp_resolver.js
 * @copyright (c) pumpCurry 2025 / 5r4ce2
 * @author pumpCurry
 * -----------------------------------------------------------
 * @module arp_resolver
 *
 * 【機能内容サマリ】
 * - OS 判定（Windows / macOS / Linux）
 * - `arp` コマンドを実行して IP → MAC アドレスを解決
 * - ARP テーブル全体のスキャン
 * - Creality OUI（fc:ee:28）の判定
 *
 * @version 1.390.830
 * @since   1.390.830
 * -----------------------------------------------------------
 */

"use strict";

const { execSync } = require("child_process");
const os = require("os");

/** Creality 社の OUI プレフィックス（確認済み: K1 Max, K1C） */
const CREALITY_OUI = "fc:ee:28";

/**
 * 指定 IP の MAC アドレスを ARP テーブルから取得する。
 * OS ごとに `arp` コマンドの出力フォーマットが異なるため、
 * プラットフォーム別にパースする。
 *
 * @param {string} ip - 対象 IP アドレス
 * @returns {string|null} MAC アドレス（小文字コロン区切り "fc:ee:28:01:4a:1b"）または null
 */
function resolveArp(ip) {
  if (!ip) return null;
  try {
    const platform = os.platform();
    let output;

    if (platform === "win32") {
      // Windows: arp -a <ip>
      // 出力例: "  192.168.54.151        fc-ee-28-01-4a-1b     動的"
      output = execSync(`arp -a ${ip}`, { encoding: "utf8", timeout: 5000 });
      const match = output.match(/([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/);
      return match ? _normalizeMac(match[1]) : null;

    } else if (platform === "darwin") {
      // macOS: arp -n <ip>
      // 出力例: "? (192.168.54.151) at fc:ee:28:01:4a:1b on en0 ifscope [ethernet]"
      output = execSync(`arp -n ${ip}`, { encoding: "utf8", timeout: 5000 });
      const match = output.match(/at\s+([0-9a-fA-F]{1,2}:[0-9a-fA-F]{1,2}:[0-9a-fA-F]{1,2}:[0-9a-fA-F]{1,2}:[0-9a-fA-F]{1,2}:[0-9a-fA-F]{1,2})/);
      return match ? _normalizeMac(match[1]) : null;

    } else {
      // Linux: arp -n <ip> または ip neigh show <ip>
      // arp 出力例: "192.168.54.151   ether   fc:ee:28:01:4a:1b   C   eth0"
      // ip neigh 出力例: "192.168.54.151 dev eth0 lladdr fc:ee:28:01:4a:1b REACHABLE"
      try {
        output = execSync(`ip neigh show ${ip}`, { encoding: "utf8", timeout: 5000 });
        const match = output.match(/lladdr\s+([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})/);
        if (match) return _normalizeMac(match[1]);
      } catch { /* ip コマンドが無い場合は arp にフォールバック */ }

      output = execSync(`arp -n ${ip}`, { encoding: "utf8", timeout: 5000 });
      const match = output.match(/([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})/);
      return match ? _normalizeMac(match[1]) : null;
    }
  } catch (e) {
    console.debug(`[arp] MAC解決失敗 (${ip}):`, e.message);
    return null;
  }
}

/**
 * ARP テーブル全体をスキャンし、全エントリを返す。
 *
 * @returns {Array<{ip: string, mac: string}>} ARP エントリ配列
 */
function scanArpTable() {
  try {
    const platform = os.platform();
    let output;
    const entries = [];

    if (platform === "win32") {
      output = execSync("arp -a", { encoding: "utf8", timeout: 10000 });
      // 各行: "  192.168.54.151        fc-ee-28-01-4a-1b     動的"
      const lines = output.split("\n");
      for (const line of lines) {
        const match = line.match(/^\s*([\d.]+)\s+([0-9a-fA-F]{2}[-][0-9a-fA-F]{2}[-][0-9a-fA-F]{2}[-][0-9a-fA-F]{2}[-][0-9a-fA-F]{2}[-][0-9a-fA-F]{2})/);
        if (match) entries.push({ ip: match[1], mac: _normalizeMac(match[2]) });
      }

    } else if (platform === "darwin") {
      output = execSync("arp -a", { encoding: "utf8", timeout: 10000 });
      // 各行: "? (192.168.54.151) at fc:ee:28:01:4a:1b on en0"
      const lines = output.split("\n");
      for (const line of lines) {
        const match = line.match(/\(([\d.]+)\)\s+at\s+([0-9a-fA-F:]+)/);
        if (match && match[2] !== "(incomplete)") entries.push({ ip: match[1], mac: _normalizeMac(match[2]) });
      }

    } else {
      // Linux: ip neigh or arp -a
      try {
        output = execSync("ip neigh", { encoding: "utf8", timeout: 10000 });
        const lines = output.split("\n");
        for (const line of lines) {
          const match = line.match(/^([\d.]+)\s+.*lladdr\s+([0-9a-fA-F:]+)/);
          if (match) entries.push({ ip: match[1], mac: _normalizeMac(match[2]) });
        }
        if (entries.length > 0) return entries;
      } catch { /* fallback */ }

      output = execSync("arp -a", { encoding: "utf8", timeout: 10000 });
      const lines = output.split("\n");
      for (const line of lines) {
        const match = line.match(/\(([\d.]+)\)\s+at\s+([0-9a-fA-F:]+)/);
        if (match) entries.push({ ip: match[1], mac: _normalizeMac(match[2]) });
      }
    }

    return entries;
  } catch (e) {
    console.debug("[arp] テーブルスキャン失敗:", e.message);
    return [];
  }
}

/**
 * MAC アドレスが Creality 社の OUI に一致するか判定する。
 *
 * @param {string} mac - MAC アドレス（正規化済み）
 * @returns {boolean}
 */
function isCrealityDevice(mac) {
  return mac?.toLowerCase().startsWith(CREALITY_OUI) ?? false;
}

/**
 * MAC アドレスを正規化する（小文字・コロン区切り）。
 * "FC-EE-28-01-4A-1B" → "fc:ee:28:01:4a:1b"
 * "fc:ee:28:1:4a:1b" → "fc:ee:28:01:4a:1b" (macOS の省略形対応)
 *
 * @private
 * @param {string} mac - 生の MAC 文字列
 * @returns {string} 正規化済み MAC
 */
function _normalizeMac(mac) {
  return mac
    .toLowerCase()
    .replace(/-/g, ":")
    .split(":")
    .map(b => b.padStart(2, "0"))
    .join(":");
}

module.exports = {
  resolveArp,
  scanArpTable,
  isCrealityDevice,
  CREALITY_OUI
};
