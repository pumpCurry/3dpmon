/**
 * @fileoverview フィラメント権威残量 anti-pattern 静的ガード（監査 P0-5 / P0-6）
 *
 * 目的:
 *   「印刷中ライブ残量を権威 spool.remainingLengthMm へ書き戻す」「resume に
 *   remainingLengthMm を載せる」というアンチパターンの再発を CI で落とす。
 *   権威残量は完了時に reconcileSpool でのみ更新する、という設計境界を固定する。
 *
 * 禁止対象（3dp_lib のコード実体。コメントは除去して走査）:
 *   - `spool.remainingLengthMm = Math.max(0, remain)`（印刷中ライブ経路の直書き）
 *   - resume の `case 'remainingLengthMm'` / `case "remainingLengthMm"`（保存・復元）
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const LIB_DIR = join(REPO_ROOT, "3dp_lib");

function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listJsFiles(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

function stripCommentsKeepLines(src) {
  let inBlock = false;
  return src.split("\n").map((line) => {
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) { i = line.length; } else { inBlock = false; i = end + 2; }
      } else {
        const lc = line.indexOf("//", i);
        const bc = line.indexOf("/*", i);
        if (bc !== -1 && (lc === -1 || bc < lc)) {
          out += line.slice(i, bc); inBlock = true; i = bc + 2;
        } else if (lc !== -1) {
          out += line.slice(i, lc); i = line.length;
        } else {
          out += line.slice(i); i = line.length;
        }
      }
    }
    return out;
  }).join("\n");
}

const BANNED = [
  {
    re: /spool\.remainingLengthMm\s*=\s*Math\.max\s*\(\s*0\s*,\s*remain\s*\)/,
    name: "spool.remainingLengthMm = Math.max(0, remain)（印刷中ライブ直書き）",
    use: "ライブ残量は storedData.filamentRemainingMm のみへ。権威は reconcileSpool（完了時）",
  },
  {
    re: /case\s+["']remainingLengthMm["']/,
    name: "case 'remainingLengthMm'（resume 保存/復元）",
    use: "remainingLengthMm は resume 対象外（reconcileSpool が導出）",
  },
];

describe("フィラメント権威残量 anti-pattern 静的ガード (3dp_lib)", () => {
  const files = listJsFiles(LIB_DIR);

  it("走査対象ファイルを検出している", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { re, name, use } of BANNED) {
    it(`「${name}」を使用していない（→ ${use}）`, () => {
      const offenders = [];
      for (const f of files) {
        const stripped = stripCommentsKeepLines(readFileSync(f, "utf8"));
        stripped.split("\n").forEach((ln, idx) => {
          if (re.test(ln)) {
            offenders.push(`${relative(REPO_ROOT, f).replace(/\\/g, "/")}:${idx + 1}  ${ln.trim().slice(0, 90)}`);
          }
        });
      }
      expect(
        offenders,
        `禁止パターン「${name}」を検出。${use}:\n${offenders.join("\n")}`
      ).toEqual([]);
    });
  }

  // ★ P0-9: aggregator は runout 復帰で自動 inferred 投入しない。
  //   addInferredSpool の呼び出しは dashboard_spool.js（定義側）等に限り、
  //   dashboard_aggregator.js からは呼ばない（センサー復帰＝交換確定にしない）。
  it("dashboard_aggregator.js が addInferredSpool を呼び出さない（P0-9 runout自動投入停止）", () => {
    const f = join(LIB_DIR, "dashboard_aggregator.js");
    const stripped = stripCommentsKeepLines(readFileSync(f, "utf8"));
    const offenders = [];
    stripped.split("\n").forEach((ln, idx) => {
      if (/addInferredSpool\s*\(/.test(ln)) {
        offenders.push(`3dp_lib/dashboard_aggregator.js:${idx + 1}  ${ln.trim().slice(0, 90)}`);
      }
    });
    expect(
      offenders,
      `aggregator からの addInferredSpool 呼び出しを検出。runout 復帰は pendingResolution＋通知に留めること:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
