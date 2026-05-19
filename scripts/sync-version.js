/**
 * @fileoverview バージョン同期スクリプト
 * package.json の version を「単一の真実」として、
 * HTML/メタタグ、その他バージョン表記箇所を自動更新する。
 *
 * 実行: node scripts/sync-version.js
 * ビルド前 (npm run build) に自動実行される。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const VERSION = pkg.version;

console.log(`[sync-version] package.json version = ${VERSION}`);

const targets = [
  {
    file: "3dp_monitor.html",
    pattern: /<meta name="app-version" content="[^"]*"\s*\/?>/,
    replace: `<meta name="app-version" content="${VERSION}" />`,
    label: "HTML meta tag"
  }
];

let updated = 0;
for (const t of targets) {
  const filePath = path.join(ROOT, t.file);
  if (!fs.existsSync(filePath)) {
    console.warn(`[sync-version] スキップ: ${t.file} (見つかりません)`);
    continue;
  }
  const orig = fs.readFileSync(filePath, "utf-8");
  if (!t.pattern.test(orig)) {
    console.warn(`[sync-version] パターン未検出: ${t.file} (${t.label})`);
    continue;
  }
  const next = orig.replace(t.pattern, t.replace);
  if (next === orig) {
    console.log(`[sync-version] 変更なし: ${t.file} (${t.label})`);
    continue;
  }
  fs.writeFileSync(filePath, next, "utf-8");
  updated++;
  console.log(`[sync-version] 更新: ${t.file} (${t.label}) → ${VERSION}`);
}

console.log(`[sync-version] 完了: ${updated} ファイル更新`);
