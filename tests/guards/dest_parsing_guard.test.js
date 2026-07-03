/**
 * @fileoverview 接続先(dest)解析 anti-pattern 静的ガード（監査 P0-2 / P0-8）
 *
 * 目的:
 *   IPv6 や hostname:port を壊す素朴な dest 解析を「書いた瞬間」に CI で落とす。
 *   すべて dashboard_target_identity.js の parseDest/normalizeDest/extractHost へ
 *   寄せること。dest は到達先であり機体同一性ではない、という設計境界を固定する。
 *
 * 禁止対象（3dp_lib のコード実体。コメントは除去して走査）:
 *   - `.split(":")[0]`               → extractHost(dest)
 *   - ポート判定の `.includes(":")`   → parseDest(dest).hasPort
 *   - `historyPersistFunc(<x>)`（第2引数 host なし） → historyPersistFunc(id, host)
 *
 * 例外: dashboard_target_identity.js（正規化ヘルパ本体。説明コメントを含む）は除外。
 *
 * コメント内の言及で誤検出しないよう、行番号を保ったままコメントを除去して走査する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const LIB_DIR = join(REPO_ROOT, "3dp_lib");

/** 正規化ヘルパ本体は走査対象外（split(":")の言及・実装が正当に存在する） */
const EXCLUDE = new Set(["dashboard_target_identity.js"]);

/** 3dp_lib 配下の .js を再帰列挙 */
function listJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listJsFiles(p));
    else if (name.endsWith(".js") && !EXCLUDE.has(name)) out.push(p);
  }
  return out;
}

/** 行数を保ったままコメント(// と ブロック)を空白化する簡易ストリッパ。 */
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

/** 禁止パターン。コメント除去後の各行に対して評価する。 */
const BANNED = [
  { re: /\.split\(\s*["']:["']\s*\)\s*\[\s*0\s*\]/, name: '.split(":")[0]', use: "extractHost(dest)" },
  { re: /\.includes\(\s*["']:["']\s*\)/, name: '.includes(":")', use: "parseDest(dest).hasPort" },
  { re: /historyPersistFunc\s*\(\s*[^,)]+\)/, name: "historyPersistFunc(x) — host 欠落", use: "historyPersistFunc(id, host)" },
];

describe("dest 解析 anti-pattern 静的ガード (3dp_lib)", () => {
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
        `禁止パターン「${name}」を検出。${use} を使うこと:\n${offenders.join("\n")}`
      ).toEqual([]);
    });
  }
});
