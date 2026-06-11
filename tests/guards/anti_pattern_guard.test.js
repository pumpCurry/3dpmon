/**
 * @fileoverview 単一ホスト("優先1ホスト")anti-pattern 静的ガード
 *
 * 目的:
 *   commission(誤った記述)型の単一ホストバグを「書いた瞬間」に CI で落とす。
 *   omission(書き漏れ)型は behavioral テスト(processData_multihost.test.js)が担当し、
 *   本ガードは「使ってはいけない非ホストスコープAPI」をソース全体から禁止する。
 *
 * 禁止対象(いずれも per-host 版が存在する):
 *   - setStoredData(...)      → setStoredDataForHost(host, ...)
 *   - getStoredData(...)      → getDisplayValue(key, host) など host 指定の読み出し
 *   - getCurrentHostname(...) → per-host の host を明示的に引き回す(v2.2.0 で廃止済)
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

/** 3dp_lib 配下の .js を再帰列挙 */
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

/**
 * 行数を保ったままコメント(// と / * * /)を空白化する簡易ストリッパ。
 * 文字列/正規表現リテラル内の // 等で取りこぼす可能性はあるが、
 * 「コメントを誤って検出する(=偽陽性)」ことは無いため、ガード用途には十分。
 * @param {string} src
 * @returns {string}
 */
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

/** 禁止 API（非ホストスコープ）。re はコメント除去後の各行に対して評価する。 */
const BANNED = [
  { re: /\bsetStoredData\s*\(/, name: "setStoredData(", use: "setStoredDataForHost(host, …)" },
  { re: /\bgetStoredData\s*\(/, name: "getStoredData(", use: "getDisplayValue(key, host) 等の host 指定読み出し" },
  { re: /\bgetCurrentHostname\s*\(/, name: "getCurrentHostname(", use: "per-host の host を明示的に渡す（v2.2.0 で廃止）" },
];

describe("単一ホスト anti-pattern 静的ガード (3dp_lib)", () => {
  const files = listJsFiles(LIB_DIR);

  it("走査対象ファイルを検出している", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { re, name, use } of BANNED) {
    it(`非ホストAPI「${name}」を使用していない（→ ${use}）`, () => {
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
        `非ホストスコープAPI「${name}」の使用を検出。per-host 版（${use}）を使うこと:\n${offenders.join("\n")}`
      ).toEqual([]);
    });
  }
});
